-- ADR-004 RI-3: muel_user_memos 인박스 → muel_memory_entries 승격 추적.
-- propose_memo(#101) / Weave "알려주기" 가 적재한 인박스를 회수 가능한 장기기억으로 ingest 한 뒤
-- ingested_at 을 찍어 재처리를 막는다. ingested_entry_id 로 승격된 memory_entry 와 연결.
alter table muel_user_memos
  add column if not exists ingested_at timestamptz,
  add column if not exists ingested_entry_id uuid;

create index if not exists idx_user_memos_pending_ingest
  on muel_user_memos (created_at) where ingested_at is null;
