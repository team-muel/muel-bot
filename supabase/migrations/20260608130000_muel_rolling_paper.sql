-- /롤링페이퍼: 멤버끼리 서로에게 남기는 한 줄(공개 레이어, /메모와 별개).
-- papers: author 1명이 target 1명에게 1개(upsert). blocks: target 이 author 를 차단.
-- bot 은 service_role 접근 → RLS enable + no policy.
create table if not exists public.muel_rolling_papers (
  id uuid primary key default gen_random_uuid(),
  author_id text not null,
  target_id text not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (author_id, target_id)
);
create index if not exists muel_rolling_papers_target_idx on public.muel_rolling_papers(target_id);
alter table public.muel_rolling_papers enable row level security;

create table if not exists public.muel_rolling_blocks (
  target_id text not null,
  author_id text not null,
  created_at timestamptz not null default now(),
  primary key (target_id, author_id)
);
alter table public.muel_rolling_blocks enable row level security;