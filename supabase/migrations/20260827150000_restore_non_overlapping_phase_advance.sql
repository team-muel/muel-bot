-- Preserve Gomdori phase advancement and AI actions without the overlapping
-- 55-second loop. The target URL must be configured per environment in Vault;
-- local or staging resets never fall back to the production project.
create or replace function public.run_phase_advance_loop()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  target_url text;
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

  perform net.http_post(
    url := rtrim(target_url, '/') || '/functions/v1/phase-advance',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );

  perform net.http_post(
    url := rtrim(target_url, '/') || '/functions/v1/match-ai-act',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.run_phase_advance_loop() from public;
revoke all on function public.run_phase_advance_loop() from anon;
revoke all on function public.run_phase_advance_loop() from authenticated;

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

  -- Preserve whatever scheduler state the environment already has until an
  -- explicit environment-local URL exists. This prevents cross-project calls
  -- and avoids disabling a separately managed deployment.
  if not has_project_url then
    raise notice 'project_url is not configured in Vault; scheduler state is unchanged';
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
    '10 seconds',
    'select public.run_phase_advance_loop()'
  );
end
$$;
