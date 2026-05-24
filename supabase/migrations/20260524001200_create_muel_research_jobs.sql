-- 20260524001200_create_muel_research_jobs.sql
-- Application-level audit for AI-Q research lane. Written by muel-bot
-- (service_role), NOT by AI-Q backend (which has no access to public schema).
--
-- MVP only uses trigger_source='user_button_dm'. Other enum values reserved
-- for future auto-enrichment patterns (scheduled/spike/mention).
--
-- Unique partial index enforces "1 enrichment per (origin, user)" at DB layer.
-- Excludes failure/cancelled/denied/timeout so a failed attempt doesn't
-- permanently block retry.

CREATE TABLE IF NOT EXISTS public.muel_research_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_job_id text NULL,
  trigger_source text NOT NULL CHECK (trigger_source IN (
    'user_button_dm',
    'scheduled_enrichment_youtube_post',
    'scheduled_enrichment_subscription',
    'spike_enrichment_community',
    'mention_research_request',
    'manual'
  )),
  trigger_detail text NULL,
  status text NOT NULL CHECK (status IN (
    'submitted', 'running', 'success', 'failure', 'cancelled', 'timeout', 'denied'
  )),
  origin_table text NULL,
  origin_id text NULL,
  discord_guild_id text NULL,
  discord_channel_id text NULL,
  requester_user_id text NULL,
  target_message_id text NULL,
  topic text NOT NULL,
  agent_type text NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  duration_ms integer NULL,
  report_excerpt text NULL,
  source_found_count integer NULL,
  source_cited_count integer NULL,
  input_tokens integer NULL,
  output_tokens integer NULL,
  total_tokens integer NULL,
  estimated_cost_usd numeric(10,4) NULL,
  delivery_channel text NULL CHECK (delivery_channel IN (
    'dm', 'fallback_ephemeral', 'fallback_thread', 'none'
  )),
  delivered_at timestamptz NULL,
  delivery_message_id text NULL,
  error_class text NULL,
  error_message text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS muel_research_jobs_button_once_per_user_idx
  ON public.muel_research_jobs (origin_table, origin_id, requester_user_id)
  WHERE trigger_source = 'user_button_dm'
    AND status NOT IN ('failure', 'cancelled', 'denied', 'timeout');

CREATE INDEX IF NOT EXISTS muel_research_jobs_trigger_created_idx
  ON public.muel_research_jobs (trigger_source, created_at DESC);
CREATE INDEX IF NOT EXISTS muel_research_jobs_status_created_idx
  ON public.muel_research_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS muel_research_jobs_requester_idx
  ON public.muel_research_jobs (requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS muel_research_jobs_origin_idx
  ON public.muel_research_jobs (origin_table, origin_id);

ALTER TABLE public.muel_research_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_research_jobs FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_research_jobs TO service_role;
