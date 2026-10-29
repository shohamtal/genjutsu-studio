begin;
-- Goodwill credits added by hand (support): one row per grant, and the balance change in the same transaction.
-- Run only by the owner through the Management API / service role; no client can call it.
create table if not exists public.credit_grants (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  credits integer not null check (credits between 1 and 10000),
  reason text not null check (length(reason) between 3 and 300),
  created_at timestamptz not null default now()
);
alter table public.credit_grants enable row level security;
revoke all on public.credit_grants from public, anon, authenticated;
revoke all on sequence public.credit_grants_id_seq from public, anon, authenticated;

create or replace function public.grant_credits(p_user uuid, p_credits integer, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  insert into credit_grants (user_id, credits, reason) values (p_user, p_credits, p_reason);
  update profiles set credits = credits + p_credits where user_id = p_user returning credits into v_balance;
  if v_balance is null then raise exception 'no profile for %', p_user; end if;
  return v_balance;
end $$;
revoke execute on function public.grant_credits(uuid, integer, text) from public, anon, authenticated;

-- The daily audit's "balance above purchases" check counts goodwill grants as purchased credits.
CREATE OR REPLACE FUNCTION public.schema_audit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_n bigint; v_tables jsonb := '[]'::jsonb;
begin
  for r in select c.relname, c.relkind, c.relrowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by 1 loop
    v_n := null;
    if r.relkind in ('r', 'p') then execute format('select count(*) from public.%I', r.relname) into v_n; end if;
    v_tables := v_tables || jsonb_build_object('name', r.relname,
      'kind', case r.relkind when 'v' then 'view' when 'm' then 'matview' else 'table' end,
      'rls', r.relrowsecurity, 'rows', v_n,
      'policies', (select coalesce(jsonb_agg(policyname order by policyname), '[]'::jsonb) from pg_policies
                    where schemaname = 'public' and tablename = r.relname));
  end loop;
  return jsonb_build_object(
    'tables', v_tables,
    'visitor_functions', (select coalesce(jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by p.proname), '[]'::jsonb)
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public'
                             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
    'buckets', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'public', public) order by id), '[]'::jsonb) from storage.buckets),
    'checks', jsonb_build_object(
      'users_without_profile', (select count(*) from auth.users u where not exists (select 1 from profiles p where p.user_id = u.id)),
      'negative_balances', (select count(*) from profiles where credits < 0),
      -- More credits than the user ever bought (minus chargebacks): credits appeared from nowhere.
      'balance_above_purchases', (select coalesce(jsonb_agg(p.user_id), '[]'::jsonb) from profiles p
                                   where p.credits > (select coalesce(sum(x.credits - coalesce(x.clawed_credits, 0)), 0)
                                                        from payments x where x.user_id = p.user_id and x.status = 'completed')
                                                     + (select coalesce(sum(g.credits), 0) from credit_grants g where g.user_id = p.user_id)),
      'credits_outstanding', (select coalesce(sum(credits), 0) from profiles),
      'completed_jobs_without_cost', (select count(*) from jobs where status = 'completed' and not mock and (cost is null or cost <= 0 or billed_secs is null)),
      'old_unfinished_jobs', (select count(*) from jobs where status in ('queued', 'in_progress', 'submitting') and created_at < now() - interval '2 hours'),
      'old_created_payments', (select count(*) from payments where status = 'created' and created_at < now() - interval '1 day' and created_at > now() - interval '8 days')
    ));
end $function$;
commit;
