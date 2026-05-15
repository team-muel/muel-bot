-- 1. Create muel_chats table (Replacing muel_conversations)
CREATE TABLE IF NOT EXISTS public.muel_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('discord', 'web', 'slack', 'system')),
  source_workspace_id text,
  source_channel_id text,
  source_thread_id text,
  source_user_id text,
  title text,
  visibility text DEFAULT 'private',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX muel_chats_unique_idx ON public.muel_chats (
  source,
  COALESCE(source_workspace_id, ''),
  source_channel_id,
  COALESCE(source_thread_id, '')
);

-- Migrate existing muel_conversations to muel_chats if desired (optional data migration could go here)
-- For now, we will just use muel_chats for new structures.

-- 2. Create muel_messages with UIMessage schema
CREATE TABLE IF NOT EXISTS public.muel_messages_v2 (
  id text PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES public.muel_chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'data')),
  parts jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'web',
  external_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muel_messages_chat_created_idx ON public.muel_messages_v2(chat_id, created_at);

ALTER TABLE public.muel_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muel_messages_v2 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.muel_chats FROM anon, authenticated;
REVOKE ALL ON TABLE public.muel_messages_v2 FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_chats TO service_role;
GRANT ALL ON TABLE public.muel_messages_v2 TO service_role;

-- 3. Create prepare_chat_turn RPC
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

  -- 2. Insert User Message
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
  ON CONFLICT (id) DO NOTHING;

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
