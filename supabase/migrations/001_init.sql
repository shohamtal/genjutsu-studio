-- Genjutsu Studio schema. Clients can only READ their own rows; every write
-- goes through edge functions (service role) or the security-definer RPCs below.

create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  credits    integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

create table public.payments (
  order_id   text primary key,              -- PayPal order id
  user_id    uuid not null references auth.users(id) on delete cascade,
  pack_id    text not null,
  usd        numeric(10,2) not null,
  credits    integer not null,
  status     text not null default 'created', -- created | completed
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  workflow      text not null,               -- motion-transfer | object-swap
  resolution    text not null,
  prompt        text not null default '',
  video_url     text not null,
  image_urls    jsonb not null,
  cost          integer not null,            -- credits held for this job
  hf_request_id text,
  status        text not null default 'submitting', -- submitting|queued|in_progress|completed|failed|nsfw|canceled
  output_url    text,
  error         text,
  refunded      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index jobs_user_created on public.jobs (user_id, created_at desc);
create unique index jobs_hf_request on public.jobs (hf_request_id);

alter table public.profiles enable row level security;
alter table public.payments enable row level security;
alter table public.jobs     enable row level security;

create policy "own profile"  on public.profiles for select using (auth.uid() = user_id);
create policy "own payments" on public.payments for select using (auth.uid() = user_id);
create policy "own jobs"     on public.jobs     for select using (auth.uid() = user_id);

-- Profile row for every new user.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomically mark a PayPal order completed and add its credits (idempotent).
create function public.complete_payment(p_order_id text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_credits integer;
begin
  update payments set status = 'completed', completed_at = now()
   where order_id = p_order_id and status = 'created'
   returning user_id, credits into v_user, v_credits;
  if v_user is not null then
    update profiles set credits = credits + v_credits where user_id = v_user;
  end if;
  return coalesce(v_credits, 0);
end $$;

-- Deduct credits if the balance allows it. Returns true on success.
create function public.spend_credits(p_user uuid, p_amount integer) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update profiles set credits = credits - p_amount
   where user_id = p_user and credits >= p_amount;
  return found;
end $$;

-- Refund a job's held credits exactly once.
create function public.refund_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_cost integer;
begin
  update jobs set refunded = true, updated_at = now()
   where id = p_job and refunded = false
   returning user_id, cost into v_user, v_cost;
  if v_user is not null then
    update profiles set credits = credits + v_cost where user_id = v_user;
  end if;
end $$;

revoke execute on function public.complete_payment(text)        from public, anon, authenticated;
revoke execute on function public.spend_credits(uuid, integer)  from public, anon, authenticated;
revoke execute on function public.refund_job(uuid)              from public, anon, authenticated;

-- Public bucket for input media; users may only upload into their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('inputs', 'inputs', true, 209715200)
on conflict (id) do nothing;

create policy "upload own inputs" on storage.objects for insert to authenticated
  with check (bucket_id = 'inputs' and (storage.foldername(name))[1] = auth.uid()::text);
