-- 20260524000400_add_hub_channel_responsive_confidence.sql
-- Item 6 — per-channel router-confidence threshold for hub auto-respond.
-- Default 0.6 matches the prior constant used in conciergeHandler.
ALTER TABLE public.muel_hub_channels
  ADD COLUMN IF NOT EXISTS responsive_confidence_min real NOT NULL DEFAULT 0.6;
