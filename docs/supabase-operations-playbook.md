# Supabase Operations Playbook

Last updated: 2026-05-31

Use this playbook for repeated `muel-bot` work that touches Supabase
migrations, Edge Functions, pg_cron, or Gomdori game state.

## Operating Rules

- Treat repo code and migration files as implementation truth, but verify the
  deployed Supabase project before claiming production state.
- Never print service role keys, database passwords, JWTs, bot tokens, or raw
  environment variable values.
- Use Docker Desktop for local migration validation when available.
- For Supabase CLI commands, check `--help` before relying on remembered flags.
- For DDL, prefer migration files plus a verified remote application path.
- Do not run `supabase migration repair` or `db push --include-all` casually.
  Those are history-reconciliation tools, not the default deployment path.

Current production project:

- Project ref: `pqzmehtuwnxyspfhyucd`
- Region: `ap-northeast-2`
- Gomdori schema: `mafia`
- Scheduler job: `mafia-phase-advance`
- Scheduler target: `/functions/v1/phase-advance`

## Local Docker Validation

Start Docker Desktop if the daemon is not running:

```powershell
docker desktop status
docker desktop start
docker info
```

If `docker info` reports the server version, run a fresh local Supabase reset:

```powershell
npx supabase db reset --local
```

This catches SQL errors across the full migration chain. If reset fails in an
older reconstructed migration, compare against the remote project before
changing files. Example:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = '<table_name>';
```

Only edit older migrations when the file is a local reconstruction of already
applied remote state and the edit makes local history match production reality.
Do not rewrite production history for convenience.

## Remote Migration Flow

First inspect pending state:

```powershell
npx supabase db push --dry-run
```

If the dry run is clean, push normally:

```powershell
npx supabase db push
```

If dry run fails with `Remote migration versions not found in local migrations
directory`, do not immediately repair remote history. This repo has had
timestamp drift between reconstructed local files and applied remote
migrations. In that case:

1. List remote migrations through the Supabase connector or CLI.
2. Confirm whether the desired change is already applied or still pending.
3. For the current DDL only, use the Supabase connector `apply_migration`.
4. Rename or create local migration files so their versions match the remote
   versions returned by the project.
5. Verify with `execute_sql` queries against actual tables, constraints,
   indexes, functions, or cron jobs.

For DDL verification, query concrete objects rather than trusting command
success text. Examples:

```sql
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'mafia.match_actions'::regclass;

select schemaname, indexname, indexdef
from pg_indexes
where schemaname = 'mafia';

select jobname, schedule, command, active
from cron.job
where jobname = 'mafia-phase-advance';
```

## Edge Function Deploy Flow

Deploy only the functions touched by the change:

```powershell
npx supabase functions deploy match-action --project-ref pqzmehtuwnxyspfhyucd --use-api
npx supabase functions deploy phase-advance --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api
```

`phase-advance` must remain `verify_jwt=false` because `pg_cron` calls it via
`net.http_post` without a Discord user JWT.

After deployment, verify both CLI and connector state:

```powershell
npx supabase functions list --project-ref pqzmehtuwnxyspfhyucd
```

If a deploy command says success but the function version has not changed,
wait briefly and list again. If it still has not changed, redeploy the specific
function with `--debug` and re-check the version and `updated_at`.

## Cron Verification

Confirm the scheduler exists and is active:

```sql
select jobname, schedule, command, active
from cron.job
where jobname = 'mafia-phase-advance';
```

Confirm it is actually running:

```sql
select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'mafia-phase-advance')
order by start_time desc
limit 5;
```

Expected shape:

- `cron.job.active = true`
- recent rows in `cron.job_run_details`
- completed rows usually show `status = succeeded`
- one current row may show `running` because the loop intentionally sleeps
  between 5-second calls inside the minute

## Standard Verification

Run these before calling the task done:

```powershell
npx supabase db reset --local
npm run test:gomdori
npm run typecheck
npm run test:smoke
git diff --check
```

For Gomdori Phase 1 specifically, also verify:

- remote `match_actions_action_type_check` includes the new action types
- remote `mafia_match_actions_one_verdict_ballot_idx` exists when verdict
  voting is involved
- `phase-advance` is deployed with `verify_jwt=false`
- `mafia-phase-advance` has recent successful run details

## Known Drift

The production migration history may contain versions not present in older
local branches. If `db push --dry-run` reports missing remote versions, treat
that as a history alignment task. Do not block unrelated Gomdori fixes if the
specific migration and deployed function can be applied and verified safely
through the connector.
