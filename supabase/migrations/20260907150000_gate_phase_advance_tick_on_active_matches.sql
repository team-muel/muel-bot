-- MUE-85: Edge Function invocation runaway.
--
-- Evidence (production, 2026-09-07): cron job `mafia-phase-advance` runs
-- `run_phase_advance_tick()` every 2 seconds and each tick posts to BOTH
-- `phase-advance` and `match-ai-act` — about 86,400 invocations per day even
-- when there is no live match at all (all 47 matches in the table are
-- aborted/ended). cron.job_run_details showed 128,949 ticks in the last 3 days.
-- That alone explains the ~600k invocations that triggered the organization
-- service restriction; client heartbeats are a rounding error next to it.
--
-- Fix: keep the 2-second cadence (phase timing needs it while a game is live)
-- but return early when nothing can need work — no match in a non-terminal
-- status. With no live match, phase-advance has no expired phases, no lobby
-- to presence-sweep, no in-progress match to abandon-sweep, and match-ai-act
-- has no AI turn to take, so skipping the HTTP calls changes nothing except
-- the bill. When a match is created the very next tick resumes normally.
create or replace function public.run_phase_advance_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  target_url text;
  cron_key text;
  request_headers jsonb;
  has_live_match boolean;
begin
  -- Gate: any match that can still change state? Terminal statuses never do.
  select exists (
    select 1
      from mafia.matches
     where status not in ('aborted', 'ended')
  ) into has_live_match;

  if not has_live_match then
    return;
  end if;

  select nullif(decrypted_secret, '')
    into target_url
    from vault.decrypted_secrets
   where name = 'project_url'
   limit 1;

  if target_url is null then
    raise warning 'project_url is not configured in Vault; skipping Gomdori scheduler tick';
    return;
  end if;

  select nullif(decrypted_secret, '')
    into cron_key
    from vault.decrypted_secrets
   where name = 'phase_advance_cron_secret'
   limit 1;

  request_headers := jsonb_build_object('Content-Type', 'application/json');
  if cron_key is not null then
    request_headers := request_headers || jsonb_build_object('x-cron-key', cron_key);
  end if;

  perform net.http_post(
    url := rtrim(target_url, '/') || '/functions/v1/phase-advance',
    headers := request_headers
  );

  perform net.http_post(
    url := rtrim(target_url, '/') || '/functions/v1/match-ai-act',
    headers := request_headers,
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.run_phase_advance_tick() from public;
revoke all on function public.run_phase_advance_tick() from anon;
revoke all on function public.run_phase_advance_tick() from authenticated;

-- The gate does a status scan on every tick; keep it an index hit.
create index if not exists matches_live_status_idx
  on mafia.matches (status)
  where status not in ('aborted', 'ended');
