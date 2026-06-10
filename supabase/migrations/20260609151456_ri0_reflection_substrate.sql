
-- ADR-004 RI-0: 사후적 지능 substrate. 읽기 광역 · 직접 쓰기 0 (제안만).
create table if not exists muel_reflection_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                         -- ai_health | speech_review | memory_health | feedback_triage | adhoc
  window_start timestamptz,
  window_end timestamptz,
  status text not null default 'open',        -- open | delivered | closed
  summary text,
  findings jsonb not null default '{}'::jsonb,
  created_by text not null default 'claude',
  created_at timestamptz not null default now()
);

create table if not exists muel_reflection_proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references muel_reflection_runs(id) on delete cascade,
  type text not null,                         -- memory_merge | prompt_edit | threshold_tweak | code_fix | triage
  title text not null,
  payload jsonb not null default '{}'::jsonb,
  decision text not null default 'pending',   -- pending | accepted | rejected | applied
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_reflection_runs_kind_created on muel_reflection_runs (kind, created_at desc);
create index if not exists idx_reflection_proposals_run on muel_reflection_proposals (run_id);
create index if not exists idx_reflection_proposals_decision on muel_reflection_proposals (decision) where decision = 'pending';

-- service_role 전용 (weave_nodes 패턴 동일). RLS on + 정책 없음 = service_role 만 접근.
alter table muel_reflection_runs enable row level security;
alter table muel_reflection_proposals enable row level security;

-- 읽기 전용 분석 뷰 ----------------------------------------------------------
create or replace view v_ai_health as
select
  date_trunc('day', created_at at time zone 'Asia/Seoul')::date as day_kst,
  task_type,
  count(*) as total,
  count(*) filter (where status = 'success')  as success,
  count(*) filter (where status = 'error')    as error,
  count(*) filter (where status = 'fallback') as fallback,
  round(100.0 * count(*) filter (where status = 'error') / nullif(count(*),0), 1) as error_pct
from muel_ai_events
group by 1, 2;

create or replace view v_action_outcomes as
select
  date_trunc('day', created_at at time zone 'Asia/Seoul')::date as day_kst,
  trigger_source,
  status,
  count(*) as n
from muel_agent_actions
group by 1, 2, 3;

create or replace view v_memory_health as
select
  status,
  width_bucket(coalesce(confidence, 0)::numeric, 0, 1, 5) as confidence_bucket,
  count(*) as n,
  round(avg(extract(epoch from (now() - created_at)) / 86400.0)::numeric, 1) as avg_age_days
from muel_memory_entries
group by 1, 2;
;
