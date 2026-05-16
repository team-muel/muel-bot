-- 202605170230_memory_atomicity.sql

-- 1. Add status field to muel_memory_entries
ALTER TABLE public.muel_memory_entries 
ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'discarded'));

-- 2. Create RPC for atomic insert
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
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry_id uuid;
BEGIN
  -- Insert entry
  INSERT INTO public.muel_memory_entries (chat_id, message_id, kind, content, importance, status)
  VALUES (p_chat_id, p_message_id, p_kind, p_content, p_importance, 'active')
  RETURNING id INTO v_entry_id;

  -- Insert embedding
  INSERT INTO public.muel_memory_embeddings (memory_id, embedding, embedding_model)
  VALUES (v_entry_id, p_embedding, p_embedding_model);

  RETURN v_entry_id;
END;
$$;

-- 3. Create RPC for atomic update/merge
CREATE OR REPLACE FUNCTION public.update_muel_memory_atomic(
  p_entry_id uuid,
  p_content text,
  p_embedding extensions.vector(768),
  p_embedding_model text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Update entry
  UPDATE public.muel_memory_entries
  SET content = p_content,
      updated_at = now()
  WHERE id = p_entry_id;

  -- Upsert embedding
  INSERT INTO public.muel_memory_embeddings (memory_id, embedding, embedding_model)
  VALUES (p_entry_id, p_embedding, p_embedding_model)
  ON CONFLICT (memory_id) DO UPDATE
  SET embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      created_at = now();
END;
$$;

-- Grant permissions
REVOKE EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(768), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_muel_memory_atomic(uuid, text, text, text, smallint, extensions.vector(768), text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(768), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_muel_memory_atomic(uuid, text, extensions.vector(768), text) TO service_role;
