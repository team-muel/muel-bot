create table if not exists public.muel_feedback_signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- 위치
  guild_id text,
  channel_id text,
  channel_type text,            -- 'dm' | 'guild' | 'thread'
  message_id text,              -- 신호를 만든 유저 메시지/리액션 대상
  muel_message_id text,         -- 피드백 대상이 된 Muel 메시지
  user_id text,                 -- 신호 발생 유저
  -- 내용
  signal_type text not null,    -- 'reaction_negative'|'reply_negative'|'abuse'|'abandon'|'deflection'|'error'
  sentiment text,               -- 'negative'|'abuse'|'neutral'
  category text,                -- 'bug'|'ux'|'tone'|'capability'|'abuse'|'unknown'
  severity smallint not null default 1,  -- 1..5
  weight numeric not null default 1,
  evidence text,                -- 원문/이모지/맥락 스니펫
  -- 트리아지
  status text not null default 'new',     -- 'new'|'triaged'|'resolved'|'ignored'
  cluster_key text,             -- 트리아지가 부여하는 군집 키
  triaged_at timestamptz,
  resolution text,
  github_issue_url text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_mfs_created_at on public.muel_feedback_signals (created_at desc);
create index if not exists idx_mfs_status on public.muel_feedback_signals (status);
create index if not exists idx_mfs_cluster on public.muel_feedback_signals (cluster_key);
create index if not exists idx_mfs_signal_type on public.muel_feedback_signals (signal_type);

-- 서비스 롤(봇)만 접근. RLS 켜고 정책 없음 → anon/auth 차단, service_role 은 bypass.
alter table public.muel_feedback_signals enable row level security;

comment on table public.muel_feedback_signals is 'Muel 부정 피드백 신호 적재 — 스케줄된 트리아지가 클러스터링/처리. Muel(봇)이 reaction/abuse/deflection 등을 INSERT.';;
