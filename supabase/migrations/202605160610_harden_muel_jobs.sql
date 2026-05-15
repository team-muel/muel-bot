-- 202605160610_harden_muel_jobs.sql

-- 1 & 4: Add dedupe_key and expand status enum to include 'dead'
alter table public.muel_jobs
  add column dedupe_key text,
  drop constraint muel_jobs_status_check,
  add constraint muel_jobs_status_check check (status in ('pending', 'running', 'done', 'failed', 'dead'));

-- 2: Unique index for deduplication
create unique index muel_jobs_type_dedupe_key_unique
on public.muel_jobs (type, dedupe_key)
where dedupe_key is not null;

-- 3: Update enqueue_job to handle dedupe_key
drop function if exists public.enqueue_job(text, jsonb);

create or replace function public.enqueue_job(
  p_type text,
  p_payload jsonb,
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_job_id uuid;
begin
  insert into public.muel_jobs (type, payload, dedupe_key)
  values (p_type, p_payload, p_dedupe_key)
  on conflict (type, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id into v_job_id
    from public.muel_jobs
    where type = p_type and dedupe_key = p_dedupe_key;
  end if;

  return v_job_id;
end;
$$;

-- 6: Modify claim_pending_jobs to handle stale running jobs (stale lock recovery)
drop function if exists public.claim_pending_jobs(text, int);

create or replace function public.claim_pending_jobs(p_worker_id text, p_limit int)
returns table (
  id uuid,
  type text,
  payload jsonb,
  attempts int
)
language plpgsql
security invoker
as $$
begin
  return query
  with next_jobs as (
    select j.id
    from public.muel_jobs j
    where (
      (j.status in ('pending', 'failed') and j.run_after <= now())
      or
      (j.status = 'running' and j.locked_at < now() - interval '10 minutes')
    )
    and j.attempts < 5
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

-- 5: Modify fail_job to handle dead letter transitions
drop function if exists public.fail_job(uuid, text, int);

create or replace function public.fail_job(
  p_job_id uuid,
  p_error text,
  p_retry_delay_seconds int,
  p_max_attempts int default 5
)
returns void
language plpgsql
security invoker
as $$
declare
  v_attempts int;
begin
  select attempts into v_attempts
  from public.muel_jobs
  where id = p_job_id and status = 'running';

  if v_attempts >= p_max_attempts then
    update public.muel_jobs
    set status = 'dead',
        last_error = p_error,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = p_job_id and status = 'running';
  else
    update public.muel_jobs
    set status = 'failed',
        last_error = p_error,
        run_after = now() + make_interval(secs := p_retry_delay_seconds),
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = p_job_id and status = 'running';
  end if;
end;
$$;
