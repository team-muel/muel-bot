# Discord Research Operations

This note tracks the operational checks for the Discord "이 소식 더 알아보기"
lane.

## Why

Discord has strict payload limits. Muel should never rely on raw LLM output
fitting inside a message or embed. Short cards are previews; full research
belongs in `muel_research_jobs.report_full`, a Markdown attachment, or a web
report surface.

## Checks

Recent research job health:

```sql
select
  status,
  trigger_source,
  origin_table,
  delivery_channel,
  count(*) as jobs,
  count(*) filter (where report_full is not null) as with_full_report,
  count(*) filter (where delivered_at is not null) as delivered,
  count(*) filter (where error_class is not null or error_message is not null) as errored,
  max(created_at) as latest_created_at
from public.muel_research_jobs
where created_at >= now() - interval '30 days'
group by status, trigger_source, origin_table, delivery_channel
order by latest_created_at desc nulls last, jobs desc;
```

Queue health:

```sql
select
  type,
  status,
  count(*) as jobs,
  max(updated_at) as latest_update,
  left(max(last_error), 220) as sample_error
from public.muel_jobs
where created_at >= now() - interval '30 days'
group by type, status
order by jobs desc;
```

AI lane health:

```sql
select
  day_kst,
  task_type,
  total,
  success,
  error,
  fallback,
  round(error_pct::numeric, 2) as error_pct
from public.v_ai_health
order by day_kst desc, error desc;
```

Hub source constraint errors:

```sql
select
  source,
  task_type,
  model_lane,
  status,
  count(*) as events,
  max(created_at) as latest,
  left(max(error_message), 220) as sample_error
from public.muel_ai_events
where created_at >= now() - interval '7 days'
group by source, task_type, model_lane, status
order by latest desc nulls last;
```

## Expected Behavior

- Quick research: show a compact ephemeral embed. If the brief is long, attach
  the full brief as Markdown.
- Deep research: DM a cover card and attach the full report as Markdown.
- DM blocked: keep the row as `pending_dm` and retry on later interactions.
- Hub chat turns: store conversation source as `discord`, with `surface:
  discord_hub` in metadata.

## Supabase Advisor Follow-Up

Security advisors should stay at zero after the hardening migration. Catalog
check for the prior RLS no-policy class:

```sql
select count(*) as rls_enabled_no_policy_remaining
from (
  select c.oid
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy pol on pol.polrelid = c.oid
  where c.relkind = 'r'
    and c.relrowsecurity
    and n.nspname in ('public','legacy_archive')
  group by c.oid
  having count(pol.oid) = 0
) t;
```

Expected: `0`.

Advisor handling policy:

- `unindexed_foreign_keys`, `duplicate_index`, `multiple_permissive_policies`,
  `security_definer_view`, `function_search_path_mutable`, and exposed
  `mafia` SECURITY DEFINER RPC warnings are actionable and should stay cleared.
- `unused_index` is not automatically dropped. Treat it as a review queue:
  compare `pg_stat_user_indexes.idx_scan`, index size, and the feature path
  before dropping. Vector indexes, low-frequency operational indexes, and newly
  added FK indexes can legitimately show zero scans for a while.
- `auth_rls_initplan` is an optimization pass, not a data-exposure finding.
  Rewrite policies from `auth.role()`, `auth.uid()`, and `auth.jwt()` to
  `(select auth.role())`, `(select auth.uid())`, and `(select auth.jwt())` in
  small schema-scoped batches so unqualified cross-schema policy references do
  not accidentally resolve to the wrong table.
