-- 20260524000200_create_muel_agent_actions.sql
-- Stage 5 — audit log for Muel agent actions across all triggers.
-- Records mentions, reactions, allowlist auto-replies, and slash command invocations.
-- Foreign key to muel_ai_events so a single agent turn links to its LLM event row.

CREATE TABLE IF NOT EXISTS public.muel_agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_source text NOT NULL CHECK (trigger_source IN (
    'mention',
    'reply_to_muel',
    'reaction',
    'allowlist_channel',
    'slash_command'
  )),
  trigger_detail text NULL,
  status text NOT NULL CHECK (status IN (
    'responded',
    'rate_limited',
    'denied',
    'error'
  )),
  discord_guild_id text NULL,
  discord_channel_id text NULL,
  discord_user_id text NULL,
  target_message_id text NULL,
  response_message_id text NULL,
  ai_event_id uuid NULL REFERENCES public.muel_ai_events(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muel_agent_actions_trigger_created_idx
  ON public.muel_agent_actions (trigger_source, created_at DESC);

CREATE INDEX IF NOT EXISTS muel_agent_actions_status_created_idx
  ON public.muel_agent_actions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS muel_agent_actions_guild_channel_created_idx
  ON public.muel_agent_actions (discord_guild_id, discord_channel_id, created_at DESC);

ALTER TABLE public.muel_agent_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_agent_actions FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_agent_actions TO service_role;
