-- 20260524000000_extend_muel_ai_events_lanes.sql
-- Extend muel_ai_events with lane/task/fallback/token columns and supporting indexes.
-- Stage 2 of AI SDK refactor.

ALTER TABLE public.muel_ai_events
  ADD COLUMN IF NOT EXISTS task_type text NULL,
  ADD COLUMN IF NOT EXISTS model_lane text NULL,
  ADD COLUMN IF NOT EXISTS fallback_reason text NULL,
  ADD COLUMN IF NOT EXISTS model_candidates jsonb NULL,
  ADD COLUMN IF NOT EXISTS input_tokens integer NULL,
  ADD COLUMN IF NOT EXISTS output_tokens integer NULL,
  ADD COLUMN IF NOT EXISTS total_tokens integer NULL;

CREATE INDEX IF NOT EXISTS muel_ai_events_task_status_created_idx
  ON public.muel_ai_events (task_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS muel_ai_events_provider_task_created_idx
  ON public.muel_ai_events (provider, task_type, created_at DESC);
