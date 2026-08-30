-- Preserve Gomdori phase advancement and AI actions without the overlapping
-- 55-second loop. The target URL must be configured per environment in Vault;
-- local or staging resets never fall back to the production project.
--
-- This uses a new tick function so an environment without project_url keeps
-- both its existing cron row and the implementation that row already invokes.
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
begin
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

do $$
declare
  target_job_id bigint;
  has_project_url boolean;
begin
  select exists(
    select 1
      from vault.decrypted_secrets
     where name = 'project_url'
       and nullif(decrypted_secret, '') is not null
  ) into has_project_url;

  -- Preserve the existing job and its referenced function until an explicit
  -- environment-local URL exists. This avoids cross-project calls without
  -- turning a separately managed scheduler into a no-op.
  if not has_project_url then
    raise notice 'project_url is not configured in Vault; scheduler and existing loop are unchanged';
    return;
  end if;

  select jobid
    into target_job_id
    from cron.job
   where jobname = 'mafia-phase-advance';

  if target_job_id is not null then
    perform cron.unschedule(target_job_id);
  end if;

  perform cron.schedule(
    'mafia-phase-advance',
    '2 seconds',
    'select public.run_phase_advance_tick()'
  );
end
$$;
