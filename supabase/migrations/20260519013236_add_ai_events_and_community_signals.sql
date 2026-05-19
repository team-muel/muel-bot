-- 20260519013236_add_ai_events_and_community_signals.sql
-- Observability for Discord AI turns and a light community-flow pipeline.

CREATE TABLE IF NOT EXISTS public.muel_ai_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'discord',
  status text NOT NULL CHECK (status IN ('success', 'fallback', 'error')),
  chat_id uuid NULL REFERENCES public.muel_chats(id) ON DELETE SET NULL,
  message_id text NULL,
  response_message_id text NULL,
  discord_guild_id text NULL,
  discord_channel_id text NULL,
  discord_user_id text NULL,
  provider text NULL,
  model text NULL,
  latency_ms integer NULL,
  lightweight_turn boolean NOT NULL DEFAULT false,
  error_class text NULL,
  error_message text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muel_ai_events_created_idx
  ON public.muel_ai_events (created_at DESC);

CREATE INDEX IF NOT EXISTS muel_ai_events_status_created_idx
  ON public.muel_ai_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS muel_ai_events_discord_channel_created_idx
  ON public.muel_ai_events (discord_channel_id, created_at DESC);

ALTER TABLE public.muel_ai_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_ai_events FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_ai_events TO service_role;

CREATE TABLE IF NOT EXISTS public.muel_community_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('volume_spike')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  message_count integer NOT NULL,
  sample_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'summarized', 'ignored', 'error')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS muel_community_signals_unique_bucket_idx
  ON public.muel_community_signals (guild_id, channel_id, signal_type, bucket_start);

CREATE INDEX IF NOT EXISTS muel_community_signals_status_created_idx
  ON public.muel_community_signals (status, created_at DESC);

ALTER TABLE public.muel_community_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_community_signals FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_community_signals TO service_role;

CREATE TABLE IF NOT EXISTS public.muel_community_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NULL REFERENCES public.muel_community_signals(id) ON DELETE SET NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muel_community_digests_created_idx
  ON public.muel_community_digests (created_at DESC);

CREATE INDEX IF NOT EXISTS muel_community_digests_channel_created_idx
  ON public.muel_community_digests (guild_id, channel_id, created_at DESC);

ALTER TABLE public.muel_community_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_community_digests FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_community_digests TO service_role;

CREATE OR REPLACE FUNCTION public.muel_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_muel_community_signals_updated_at ON public.muel_community_signals;
CREATE TRIGGER trg_muel_community_signals_updated_at
  BEFORE UPDATE ON public.muel_community_signals
  FOR EACH ROW
  EXECUTE FUNCTION public.muel_touch_updated_at();

ALTER TABLE public.muel_jobs
  DROP CONSTRAINT IF EXISTS muel_jobs_type_check;

ALTER TABLE public.muel_jobs
  ADD CONSTRAINT muel_jobs_type_check
  CHECK (type IN (
    'extract_memory',
    'embed_memory',
    'summarize_chat',
    'sync_youtube_sources',
    'discord_interaction_subscribe',
    'summarize_community_flow'
  ));
