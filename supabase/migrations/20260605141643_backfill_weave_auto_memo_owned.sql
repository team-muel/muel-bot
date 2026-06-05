-- ADR-002 backfill (corrected). muel_chats.source_user_id is NULL system-wide
-- (chats are channel-scoped), so the auto_memo owner is resolved from the
-- triggering message author: muel_messages_v2.metadata->>'discordUserId'.
--
-- Only memories with a DIRECT, unambiguous owner (own message author) are
-- backfilled. Assistant-triggered memories and multi-user channel chats are
-- intentionally skipped — no misattribution of a private memory into the wrong
-- user's private graph. The forward producer (memoryWorker.ts) is fixed to use
-- the same message-author attribution so new auto_memos get the right owner.
--
-- Applied to remote = 24 auto_memo nodes (+24 embeddings) across 3 owners.
-- Idempotent + reversible: delete from public.weave_nodes where source_ref->>'backfill'='true';

with owned as (
  select e.id as memory_id, e.content, e.kind, e.importance, e.created_at,
         (m.metadata->>'discordUserId') as owner
  from public.muel_memory_entries e
  join public.muel_messages_v2 m on m.id = e.message_id
  where e.status = 'active'
    and (m.metadata->>'discordUserId') is not null
    and not exists (
      select 1 from public.weave_nodes w
      where w.source_kind = 'auto_memo'
        and w.source_ref->>'muel_memory_entries_id' = e.id::text
    )
),
ins as (
  insert into public.weave_nodes (source_kind, owner_user_id, visibility, body, tags, source_ref, created_at)
  select 'auto_memo', owned.owner, 'private', owned.content,
         array_remove(array[owned.kind], null),
         jsonb_build_object('muel_memory_entries_id', owned.memory_id, 'importance', owned.importance, 'backfill', true),
         owned.created_at
  from owned
  returning id, (source_ref->>'muel_memory_entries_id') as mem_id
)
insert into public.weave_node_embeddings (node_id, embedding, embedding_model)
select ins.id, me.embedding, coalesce(me.embedding_model, 'gemini-embedding-001')
from ins
join public.muel_memory_embeddings me on me.memory_id = ins.mem_id::uuid
on conflict (node_id) do nothing;
