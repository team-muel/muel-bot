-- 202605170250_fix_rpc_dimension_and_retrieval.sql

-- 1. Fix RPC vector dimension mismatch (768 → 1536) and switch to SECURITY DEFINER

-- Drop old functions first (they have wrong vector(768) signatures)
DROP FUNCTION IF EXISTS public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(768), text);
DROP FUNCTION IF EXISTS public.update_muel_memory_atomic(uuid, text, extensions.vector(768), text);

-- Recreate with correct 1536 dimension + SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.insert_muel_memory_atomic(
  p_chat_id uuid,
  p_message_id text,
  p_kind text,
  p_content text,
  p_importance smallint,
  p_embedding extensions.vector(1536),
  p_embedding_model text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_entry_id uuid;
BEGIN
  INSERT INTO public.muel_memory_entries (chat_id, message_id, kind, content, importance, status)
  VALUES (p_chat_id, p_message_id, p_kind, p_content, p_importance, 'active')
  RETURNING id INTO v_entry_id;

  INSERT INTO public.muel_memory_embeddings (memory_id, embedding, embedding_model)
  VALUES (v_entry_id, p_embedding, p_embedding_model);

  RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_muel_memory_atomic(
  p_entry_id uuid,
  p_content text,
  p_embedding extensions.vector(1536),
  p_embedding_model text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  UPDATE public.muel_memory_entries
  SET content = p_content,
      updated_at = now()
  WHERE id = p_entry_id;

  INSERT INTO public.muel_memory_embeddings (memory_id, embedding, embedding_model)
  VALUES (p_entry_id, p_embedding, p_embedding_model)
  ON CONFLICT (memory_id) DO UPDATE
  SET embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      created_at = now();
END;
$$;

-- 2. Create RPC for fetching active memories by user (user-wide, not chat-wide)
CREATE OR REPLACE FUNCTION public.fetch_active_memories_by_user(p_user_id text)
RETURNS TABLE (
  id uuid,
  content text,
  importance smallint,
  kind text,
  status text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT e.id, e.content, e.importance, e.kind, e.status, e.created_at
  FROM public.muel_memory_entries e
  JOIN public.muel_chats c ON e.chat_id = c.id
  WHERE c.source_user_id = p_user_id
    AND e.status = 'active'
  ORDER BY e.importance DESC, e.updated_at DESC;
$$;

-- 3. Create RPC for similarity-based memory retrieval
-- Uses pgvector cosine distance operator
CREATE OR REPLACE FUNCTION public.match_user_memories(
  p_user_id text,
  p_query_embedding extensions.vector(1536),
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
  SELECT
    e.id,
    e.content,
    e.importance,
    e.kind,
    (1 - (emb.embedding OPERATOR(extensions.<=>) p_query_embedding))::float AS similarity
  FROM public.muel_memory_entries e
  JOIN public.muel_chats c ON e.chat_id = c.id
  JOIN public.muel_memory_embeddings emb ON emb.memory_id = e.id
  WHERE c.source_user_id = p_user_id
    AND e.status = 'active'
    AND (1 - (emb.embedding OPERATOR(extensions.<=>) p_query_embedding)) > p_match_threshold
  ORDER BY similarity DESC
  LIMIT p_match_count;
END;
$$;

-- 4. Permissions
REVOKE EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(1536), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(1536), text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(1536), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(1536), text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fetch_active_memories_by_user(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fetch_active_memories_by_user(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(1536), float, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(1536), float, int) TO service_role;
