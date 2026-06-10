
-- ADR-004 RI-3: user_memos 인박스 → memory_entries 승격 추적 컬럼.
alter table muel_user_memos
  add column if not exists ingested_at timestamptz,
  add column if not exists ingested_entry_id uuid;
create index if not exists idx_user_memos_pending_ingest
  on muel_user_memos (created_at) where ingested_at is null;
;
