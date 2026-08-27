-- Preserve Gomdori phase advancement without the overlapping 55-second loop.
-- The previous implementation issued 12 requests and slept between them while a
-- separate 10-second cron started more copies. One short request per tick keeps
-- phase transitions live without long-running database sessions.
create or replace function public.run_phase_advance_loop()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target_url text;
begin
  target_url := coalesce(
    nullif(current_setting('mafia.supabase_url', true), ''),
    'https://pqzmehtuwnxyspfhyucd.supabase.co'
  );

  perform net.http_post(
    url := target_url || '/functions/v1/phase-advance',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;

revoke all on function public.run_phase_advance_loop() from public;
revoke all on function public.run_phase_advance_loop() from anon;
revoke all on function public.run_phase_advance_loop() from authenticated;

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

  perform cron.schedule(
    'mafia-phase-advance',
    '10 seconds',
    'select public.run_phase_advance_loop()'
  );
end
$$;
