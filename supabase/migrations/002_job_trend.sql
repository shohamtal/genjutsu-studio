-- Which trend page a job came from (slug from site/trends.json, or 'custom').
alter table public.jobs add column if not exists trend text not null default 'custom';
