-- This Supabase project hosts Muel. An unrelated Mafia loop was left running
-- every ten seconds; each invocation sleeps for 55 seconds and enqueues 24 HTTP
-- calls, causing overlapping sessions and sustained pg_net pressure.
do $$
declare
  target_job_id bigint;
begin
  select jobid
    into target_job_id
    from cron.job
   where jobname = 'mafia-phase-advance';

  if target_job_id is not null then
    perform cron.unschedule(target_job_id);
  end if;
end
$$;
