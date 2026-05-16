-- Live memory schema boundary only.
-- Do not backfill legacy_archive memory here, and do not implement retrieval tooling in this migration.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.muel_memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NULL REFERENCES public.muel_chats(id) ON DELETE SET NULL,
  message_id text NULL REFERENCES public.muel_messages_v2(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('fact', 'preference', 'project', 'decision', 'summary')),
  content text NOT NULL,
  importance smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  confidence real NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.muel_memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES public.muel_memory_entries(id) ON DELETE CASCADE,
  embedding extensions.vector(1536) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.muel_memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muel_memory_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access to muel_memory_entries" ON public.muel_memory_entries;
CREATE POLICY "Allow service role full access to muel_memory_entries"
  ON public.muel_memory_entries
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access to muel_memory_embeddings" ON public.muel_memory_embeddings;
CREATE POLICY "Allow service role full access to muel_memory_embeddings"
  ON public.muel_memory_embeddings
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.muel_memory_entries FROM anon, authenticated;
REVOKE ALL ON TABLE public.muel_memory_embeddings FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_memory_entries TO service_role;
GRANT ALL ON TABLE public.muel_memory_embeddings TO service_role;

CREATE INDEX IF NOT EXISTS muel_memory_entries_chat_created_idx
  ON public.muel_memory_entries(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS muel_memory_entries_kind_created_idx
  ON public.muel_memory_entries(kind, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_muel_memory_entries_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_muel_memory_entries_updated_at ON public.muel_memory_entries;
CREATE TRIGGER set_muel_memory_entries_updated_at
  BEFORE UPDATE ON public.muel_memory_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_muel_memory_entries_updated_at();

REVOKE EXECUTE ON FUNCTION public.set_muel_memory_entries_updated_at() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_muel_memory_entries_updated_at() TO service_role;
