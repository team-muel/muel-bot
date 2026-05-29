-- 20260528010000_create_muel_youtube_items.sql
-- Persistent YouTube curation cache. Written by muel-bot service_role after
-- videos.xml / best-effort community post detection, optionally enriched with
-- YouTube Data API metadata.

CREATE TABLE IF NOT EXISTS public.muel_youtube_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id integer NULL,
  kind text NOT NULL CHECK (kind IN ('video', 'shorts', 'community_post')),
  youtube_id text NOT NULL,
  channel_id text NULL,
  channel_title text NULL,
  title text NULL,
  description text NULL,
  url text NOT NULL,
  published_at timestamptz NULL,
  is_shorts boolean NULL,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  category_id text NULL,
  duration text NULL,
  statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
  topic_categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, youtube_id)
);

CREATE INDEX IF NOT EXISTS muel_youtube_items_source_seen_idx
  ON public.muel_youtube_items (source_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS muel_youtube_items_kind_published_idx
  ON public.muel_youtube_items (kind, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS muel_youtube_items_channel_seen_idx
  ON public.muel_youtube_items (channel_id, last_seen_at DESC);

ALTER TABLE public.muel_youtube_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_youtube_items FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_youtube_items TO service_role;
