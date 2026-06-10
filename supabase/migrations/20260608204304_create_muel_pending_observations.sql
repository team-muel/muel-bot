create table if not exists public.muel_pending_observations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  observe_after timestamptz not null,        -- 이 시각 이후 관찰 수행
  status text not null default 'pending',     -- pending|done|error
  guild_id text,
  channel_id text not null,
  muel_message_id text not null,              -- 관찰 대상: Muel 답변 메시지
  user_id text,                               -- Muel 이 답한 상대
  reply_excerpt text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_mpo_due on public.muel_pending_observations (status, observe_after);
alter table public.muel_pending_observations enable row level security;
comment on table public.muel_pending_observations is 'Muel 답변 후 지연 관찰 큐 — 봇 폴러가 ~90s 뒤 리액션/후속 반응을 보고 muel_feedback_signals 에 적재.';

-- 보존 cron 에 관찰 큐 정리 추가(이름 동일 → 갱신).
select cron.schedule(
  'muel_log_retention',
  '13 18 * * *',
  $$
    delete from public.muel_ai_events where created_at < now() - interval '72 hours';
    delete from public.muel_feedback_signals where created_at < now() - interval '72 hours' and status in ('triaged','resolved','ignored');
    delete from public.muel_pending_observations where created_at < now() - interval '72 hours';
    delete from public.muel_messages_v2 where created_at < now() - interval '168 hours';
  $$
);;
