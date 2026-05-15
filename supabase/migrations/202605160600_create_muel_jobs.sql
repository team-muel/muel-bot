-- 202605160600_create_muel_jobs.sql

create table if not exists public.muel_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('extract_memory', 'embed_memory', 'summarize_chat')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for finding pending/retryable jobs quickly
create index if not exists muel_jobs_fetch_idx 
on public.muel_jobs (status, run_after) 
where status in ('pending', 'failed');

alter table public.muel_jobs enable row level security;

revoke all on table public.muel_jobs from anon, authenticated;
grant all on table public.muel_jobs to service_role;

-- Trigger to automatically update updated_at
create or replace function public.muel_jobs_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

drop trigger if exists trg_muel_jobs_updated_at on public.muel_jobs;
create trigger trg_muel_jobs_updated_at
  before update on public.muel_jobs
  for each row
  execute function public.muel_jobs_update_updated_at();

-- RPC: Claim pending jobs safely with FOR UPDATE SKIP LOCKED
create or replace function public.claim_pending_jobs(p_worker_id text, p_limit int)
returns table (
  id uuid,
  type text,
  payload jsonb,
  attempts int
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return query
  with next_jobs as (
    select j.id
    from public.muel_jobs j
    where j.status in ('pending', 'failed')
      and j.run_after <= now()
      -- Arbitrary retry limit (e.g. 5) can be applied in the application, or here
      and j.attempts < 10
    order by j.run_after asc, j.created_at asc
    limit least(greatest(p_limit, 1), 50)
    for update skip locked
  )
  update public.muel_jobs
  set status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      attempts = public.muel_jobs.attempts + 1,
      updated_at = now()
  from next_jobs
  where public.muel_jobs.id = next_jobs.id
  returning public.muel_jobs.id, public.muel_jobs.type, public.muel_jobs.payload, public.muel_jobs.attempts;
end;
$$;

-- RPC: Complete job
create or replace function public.complete_job(p_job_id uuid)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.muel_jobs
  set status = 'done',
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id and status = 'running';
$$;

-- RPC: Fail job with retry delay
create or replace function public.fail_job(p_job_id uuid, p_error text, p_retry_delay_seconds int)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.muel_jobs
  set status = 'failed',
      last_error = p_error,
      run_after = now() + make_interval(secs := p_retry_delay_seconds),
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id and status = 'running';
$$;

-- RPC: Enqueue job safely
create or replace function public.enqueue_job(p_type text, p_payload jsonb)
returns uuid
language sql
security invoker
set search_path = public, pg_temp
as $$
  insert into public.muel_jobs (type, payload)
  values (p_type, p_payload)
  returning id;
$$;

revoke execute on function public.claim_pending_jobs(text, int) from public, anon, authenticated;
revoke execute on function public.complete_job(uuid) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.enqueue_job(text, jsonb) from public, anon, authenticated;

grant execute on function public.claim_pending_jobs(text, int) to service_role;
grant execute on function public.complete_job(uuid) to service_role;
grant execute on function public.fail_job(uuid, text, int) to service_role;
grant execute on function public.enqueue_job(text, jsonb) to service_role;
