-- 20260524000300_create_muel_hub_channels.sql
-- Stage 5 (revised) — hub channel allowlist. /허브 활성화 inserts a row,
-- /허브 비활성화 deletes it. Hub channel messages get router-gated auto-respond
-- via conciergeHandler.handleHubChannelMessage.

CREATE TABLE IF NOT EXISTS public.muel_hub_channels (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  activated_by_discord_user_id text NULL,
  activated_by_discord_username text NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS muel_hub_channels_guild_idx
  ON public.muel_hub_channels (guild_id);

ALTER TABLE public.muel_hub_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.muel_hub_channels FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_hub_channels TO service_role;
