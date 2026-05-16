-- 202605170430_optimize_memory_retrieval_indexes.sql
-- Tighten retrieval hot path for match_user_memories and align queue job types with runtime code.

-- 1. Ensure the active memory embedding table has its vector index.
-- The production history already created this name in 20260516205723; keep the
-- same name here so we do not create a duplicate HNSW index on the hot path.
CREATE INDEX IF NOT EXISTS muel_memory_embeddings_vector_idx
  ON public.muel_memory_embeddings
  USING hnsw (embedding extensions.vector_cosine_ops);

-- 2. Add relational indexes that match the retrieval join/filter pattern.
CREATE INDEX IF NOT EXISTS muel_chats_source_user_id_idx
  ON public.muel_chats (source_user_id);

CREATE INDEX IF NOT EXISTS muel_memory_entries_chat_id_status_idx
  ON public.muel_memory_entries (chat_id, status);

-- 3. The app now uses muel_jobs for YouTube sync and deferred Discord
-- interaction work, not only memory extraction.
ALTER TABLE public.muel_jobs
  DROP CONSTRAINT IF EXISTS muel_jobs_type_check;

ALTER TABLE public.muel_jobs
  ADD CONSTRAINT muel_jobs_type_check
  CHECK (type IN (
    'extract_memory',
    'embed_memory',
    'summarize_chat',
    'sync_youtube_sources',
    'discord_interaction_subscribe'
  ));

-- 4. Recreate RPC so planner can use distance ordering directly.
CREATE OR REPLACE FUNCTION public.match_user_memories(
  p_user_id text,
  p_query_embedding extensions.vector(768),
  p_match_threshold float,
  p_match_count int
)
RETURNS TABLE (
  id uuid,
  content text,
  importance smallint,
  kind text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT
      e.id,
      e.content,
      e.importance,
      e.kind,
      (emb.embedding OPERATOR(extensions.<=>) p_query_embedding) AS distance
    FROM public.muel_memory_entries e
    JOIN public.muel_chats c ON e.chat_id = c.id
    JOIN public.muel_memory_embeddings emb ON emb.memory_id = e.id
    WHERE c.source_user_id = p_user_id
      AND e.status = 'active'
    ORDER BY emb.embedding OPERATOR(extensions.<=>) p_query_embedding ASC
    LIMIT GREATEST(p_match_count * 4, p_match_count)
  )
  SELECT
    ranked.id,
    ranked.content,
    ranked.importance,
    ranked.kind,
    (1 - ranked.distance)::float AS similarity
  FROM ranked
  WHERE (1 - ranked.distance) > p_match_threshold
  ORDER BY ranked.distance ASC
  LIMIT p_match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(768), float, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(768), float, int) TO service_role;
