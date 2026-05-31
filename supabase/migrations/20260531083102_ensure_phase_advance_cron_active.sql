-- Re-assert the Phase 1 phase-advance scheduler for databases where the older
-- 20260516000000 migration was already applied before cron was hardened.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

create or replace function public.run_phase_advance_loop()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
DECLARE
  i integer;
  target_url text;
BEGIN
  target_url := coalesce(
    nullif(current_setting('mafia.supabase_url', true), ''),
    'https://pqzmehtuwnxyspfhyucd.supabase.co'
  );

  for i in 1..12 loop
    perform net.http_post(
      url:= target_url || '/functions/v1/phase-advance',
      headers:='{"Content-Type": "application/json"}'::jsonb
    );

    if i < 12 then
      perform pg_sleep(5);
    end if;
  end loop;
end;
$$;

revoke all on function public.run_phase_advance_loop() from public;
revoke all on function public.run_phase_advance_loop() from anon;
revoke all on function public.run_phase_advance_loop() from authenticated;

do $$
begin
  perform cron.unschedule('mafia-phase-advance');
exception
  when others then
    null;
end
$$;

select cron.schedule('mafia-phase-advance', '* * * * *', 'select public.run_phase_advance_loop()');
