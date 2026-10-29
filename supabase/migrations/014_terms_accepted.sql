-- When the visitor ticked "I understand the video is made by AI ... I agree to the Terms" before Generate.
-- Additive and nullable: older pages don't send it. Written only by the generate edge function (service role).
alter table public.jobs add column if not exists terms_accepted_at timestamptz;
