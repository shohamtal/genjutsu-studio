-- Public feed + Recreate + reports (2026-11-08). Additive only.
-- An owner publishes a finished video on My videos ("Publish to the main feed"). The jobs edge function copies the
-- output, the source video and the photos to the public "feed" bucket (uploads are deleted after 7 days) and sets
-- published_at. The feed edge function lists published posts; anyone can Recreate one (generate accepts the post's
-- feed files) or report it. Reports wait for the owner's review in the admin dashboard (moderate edge function).
-- gallery_opt_in_at (013) stays as it is: it was a narrower consent (no photos, no source video), so it never publishes.
begin;
alter table public.jobs
  add column if not exists published_at timestamptz,  -- consent to the feed (video, prompt, source video, photos)
  add column if not exists feed_video   text,         -- public URL: feed/<job id>/out.mp4
  add column if not exists feed_source  text,         -- public URL: feed/<job id>/source.<ext>
  add column if not exists feed_images  text[],       -- public URLs: feed/<job id>/<n>.<ext>, in image_urls order
  add column if not exists removed_at   timestamptz,  -- the owner of the site removed it after a report
  add column if not exists remix_of     uuid references public.jobs(id) on delete set null; -- made with Recreate from this post
create index if not exists jobs_feed on public.jobs (published_at desc)
  where published_at is not null and hidden_at is null and removed_at is null;

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  kind        text not null check (kind in ('copyright', 'consent', 'other')),
  email       text not null check (char_length(email) between 3 and 254),
  details     text not null check (char_length(details) between 1 and 2000),
  created_at  timestamptz not null default now(),
  outcome     text check (outcome in ('removed', 'dismissed')),
  resolved_at timestamptz,
  ip_hash     text,  -- salted SHA-256 of the reporter's IP, only for rate limits
  unique (job_id, email)
);
create index if not exists reports_open on public.reports (created_at) where outcome is null;
create index if not exists reports_ip on public.reports (ip_hash, created_at);
create index if not exists jobs_remix_of on public.jobs (remix_of) where remix_of is not null;
alter table public.reports enable row level security;  -- no policies: only the service role reads or writes
revoke all on public.reports from public, anon, authenticated;

alter table public.profiles
  add column if not exists strikes int not null default 0,       -- posts removed after a report
  add column if not exists publish_banned_at timestamptz;        -- set at the 3rd strike: can't publish any more

-- Public bucket for published posts. No storage policies: only the service role (edge functions) writes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('feed', 'feed', true, 209715200)
on conflict (id) do nothing;

-- Remove a reported post and count a strike, in one transaction. Returns the owner's strike count, or null if the
-- report was already resolved. At 3 strikes the owner can't publish and every other live post of theirs is unpublished.
create or replace function public.remove_reported(p_report uuid, p_ban_at integer default 3)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job uuid; v_user uuid; v_strikes integer; v_was_live boolean;
begin
  update reports set outcome = 'removed', resolved_at = now() where id = p_report and outcome is null returning job_id into v_job;
  if v_job is null then return null; end if;
  -- Close the other open reports on the same post too.
  update reports set outcome = 'removed', resolved_at = now() where job_id = v_job and outcome is null;
  update jobs set removed_at = now() where id = v_job and removed_at is null returning user_id into v_user;
  v_was_live := v_user is not null;
  if not v_was_live then select user_id into v_user from jobs where id = v_job; return (select strikes from profiles where user_id = v_user); end if;
  update profiles set strikes = strikes + 1 where user_id = v_user returning strikes into v_strikes;
  if v_strikes >= greatest(p_ban_at, 1) then
    update profiles set publish_banned_at = coalesce(publish_banned_at, now()) where user_id = v_user;
    update jobs set published_at = null where user_id = v_user and published_at is not null and removed_at is null;
  end if;
  return v_strikes;
end $$;
revoke execute on function public.remove_reported(uuid, integer) from public, anon, authenticated;

-- Feed files that belong to no live post (a publish that crashed mid-copy, a delete that failed, or a Recreate whose original left): cleanup-inputs
-- deletes them. Only files older than 1 hour, so a publish in progress is never touched.
create or replace function public.orphan_feed_files(p_limit integer) returns setof text
language sql security definer set search_path = public, storage, pg_temp as $$
  select o.name from storage.objects o
   where o.bucket_id = 'feed' and greatest(o.created_at, o.updated_at) < now() - interval '1 hour'
     and not exists (select 1 from public.jobs j where j.id::text = split_part(o.name, '/', 1)
                       and j.published_at is not null and j.hidden_at is null and j.removed_at is null
                       -- a Recreate is live only while the post it was made from is live
                       and (j.remix_of is null or exists (select 1 from public.jobs r where r.id = j.remix_of
                              and r.published_at is not null and r.hidden_at is null and r.removed_at is null)))
   order by o.created_at limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function public.orphan_feed_files(integer) from public, anon, authenticated;
commit;
