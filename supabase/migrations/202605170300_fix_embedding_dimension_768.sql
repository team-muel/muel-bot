-- 202605170300_fix_embedding_dimension_768.sql
-- Muel stores Gemini embeddings at 768 dimensions.
-- The configured embedding model must honor that output dimensionality.

-- 1. Alter the embeddings table to use vector(768)
ALTER TABLE public.muel_memory_embeddings
  ALTER COLUMN embedding TYPE extensions.vector(768);

-- 2. Recreate RPCs with correct 768 dimension

DROP FUNCTION IF EXISTS public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(1536), text);
DROP FUNCTION IF EXISTS public.update_muel_memory_atomic(uuid, text, extensions.vector(1536), text);
DROP FUNCTION IF EXISTS public.match_user_memories(text, extensions.vector(1536), float, int);

CREATE OR REPLACE FUNCTION public.insert_muel_memory_atomic(
  p_chat_id uuid,
  p_message_id text,
  p_kind text,
  p_content text,
  p_importance smallint,
  p_embedding extensions.vector(768),
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
  p_embedding extensions.vector(768),
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

-- 3. Permissions
REVOKE EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(768), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(768), text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(768), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(768), text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(768), float, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_user_memories(text, extensions.vector(768), float, int) TO service_role;
