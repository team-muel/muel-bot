-- ADR-002: Backfill pre-existing PRIVATE knowledge assets into weave_nodes.
-- NOTE: superseded by 20260605141643_backfill_weave_auto_memo_owned.sql.
-- This first attempt joined muel_chats.source_user_id for the auto_memo owner,
-- but that column is NULL system-wide (chats are channel-scoped), so the
-- auto_memo branch inserted 0 rows. Kept for migration-history parity with the
-- remote project. Idempotent + reversible (source_ref.backfill=true):
--   delete from public.weave_nodes where source_ref->>'backfill' = 'true';
-- Dreams are intentionally NOT backfilled — /weave reads the dreams table
-- directly, so copying them into weave_nodes would double them in the graph.

-- 1) auto_memo (SUPERSEDED — owner via muel_chats.source_user_id was NULL).
with ins_auto as (
  insert into public.weave_nodes (source_kind, owner_user_id, visibility, title, body, tags, source_ref, created_at)
  select 'auto_memo', c.source_user_id, 'private', null, e.content,
         array_remove(array[e.kind], null),
         jsonb_build_object('muel_memory_entries_id', e.id, 'importance', e.importance, 'backfill', true),
         e.created_at
  from public.muel_memory_entries e
  join public.muel_chats c on c.id = e.chat_id
  where e.status = 'active'
    and c.source_user_id is not null
    and not exists (
      select 1 from public.weave_nodes w
      where w.source_kind = 'auto_memo'
        and w.source_ref->>'muel_memory_entries_id' = e.id::text
    )
  returning id, (source_ref->>'muel_memory_entries_id') as mem_id
)
insert into public.weave_node_embeddings (node_id, embedding, embedding_model)
select ins_auto.id, me.embedding, coalesce(me.embedding_model, 'gemini-embedding-001')
from ins_auto
join public.muel_memory_embeddings me on me.memory_id = ins_auto.mem_id::uuid
on conflict (node_id) do nothing;

-- 2) user_memo: muel_user_memos -> weave_nodes (no stored embedding).
insert into public.weave_nodes (source_kind, owner_user_id, visibility, body, source_ref, created_at)
select 'user_memo', m.discord_user_id, 'private', m.content,
       jsonb_build_object('muel_user_memos_id', m.id, 'backfill', true), m.created_at
from public.muel_user_memos m
where not exists (
  select 1 from public.weave_nodes w
  where w.source_kind = 'user_memo'
    and w.source_ref->>'muel_user_memos_id' = m.id::text
);

-- 3) research_report: success jobs with a report body -> weave_nodes (no stored embedding).
insert into public.weave_nodes (source_kind, owner_user_id, visibility, title, body, tags, source_ref, created_at)
select 'research_report', r.requester_user_id, 'private', r.topic,
       coalesce(r.report_full, r.report_excerpt),
       array['research'],
       jsonb_build_object('research_job_id', r.id, 'source_cited', r.source_cited_count, 'backfill', true),
       coalesce(r.completed_at, r.created_at)
from public.muel_research_jobs r
where r.status = 'success'
  and coalesce(r.report_full, r.report_excerpt) is not null
  and r.requester_user_id is not null
  and not exists (
    select 1 from public.weave_nodes w
    where w.source_kind = 'research_report'
      and w.source_ref->>'research_job_id' = r.id::text
  );
