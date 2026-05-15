-- 202605160715_harden_muel_messages_idempotency.sql

-- 1. Clean up existing duplicates before applying unique index
DELETE FROM public.muel_messages_v2 a
USING public.muel_messages_v2 b
WHERE a.source = b.source 
  AND a.external_message_id = b.external_message_id
  AND a.external_message_id IS NOT NULL
  AND a.created_at > b.created_at;

-- 2. Create unique index for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS muel_messages_v2_source_external_unique 
ON public.muel_messages_v2 (source, external_message_id) 
WHERE external_message_id IS NOT NULL;

-- 2. Update prepare_chat_turn to use this index
CREATE OR REPLACE FUNCTION public.prepare_chat_turn(
  p_source text,
  p_source_channel_id text,
  p_source_thread_id text,
  p_user_message_id text,
  p_user_parts jsonb,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_chat_id uuid;
  v_messages jsonb;
BEGIN
  -- 1. Upsert Chat
  INSERT INTO public.muel_chats (
    source,
    source_workspace_id,
    source_channel_id,
    source_thread_id,
    metadata
  )
  VALUES (
    p_source,
    p_metadata->>'discordGuildId',
    p_source_channel_id,
    p_source_thread_id,
    '{}'::jsonb
  )
  ON CONFLICT (source, COALESCE(source_workspace_id, ''), source_channel_id, COALESCE(source_thread_id, '')) DO NOTHING;

  SELECT id
  INTO v_chat_id
  FROM public.muel_chats
  WHERE source = p_source
    AND COALESCE(source_workspace_id, '') = COALESCE(p_metadata->>'discordGuildId', '')
    AND source_channel_id = p_source_channel_id
    AND COALESCE(source_thread_id, '') = COALESCE(p_source_thread_id, '')
  ORDER BY created_at DESC
  LIMIT 1;

  -- 2. Insert User Message with Idempotency
  IF p_metadata->>'externalMessageId' IS NOT NULL THEN
    INSERT INTO public.muel_messages_v2 (
      id,
      chat_id,
      role,
      parts,
      source,
      external_message_id,
      metadata
    )
    VALUES (
      p_user_message_id,
      v_chat_id,
      'user',
      p_user_parts,
      p_source,
      p_metadata->>'externalMessageId',
      p_metadata
    )
    ON CONFLICT (source, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING;
  ELSE
    INSERT INTO public.muel_messages_v2 (
      id,
      chat_id,
      role,
      parts,
      source,
      external_message_id,
      metadata
    )
    VALUES (
      p_user_message_id,
      v_chat_id,
      'user',
      p_user_parts,
      p_source,
      NULL,
      p_metadata
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- 3. Fetch Recent Messages
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'role', role,
      'parts', parts,
      'metadata', metadata,
      'createdAt', created_at
    )
    ORDER BY created_at ASC
  )
  INTO v_messages
  FROM (
    SELECT *
    FROM public.muel_messages_v2
    WHERE chat_id = v_chat_id
    ORDER BY created_at DESC
    LIMIT 20
  ) recent;

  RETURN jsonb_build_object(
    'chatId', v_chat_id,
    'messages', coalesce(v_messages, '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prepare_chat_turn(text, text, text, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_chat_turn(text, text, text, text, jsonb, jsonb) TO service_role;
