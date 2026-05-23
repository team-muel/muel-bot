-- 20260524000100_create_muel_ai_daily_cost_view.sql
-- Stage 3.3 — lane/model/provider rollup for ad-hoc cost & health queries.
-- Pure SQL view, no row-level cost calculation (multiply by current pricing externally).

CREATE OR REPLACE VIEW public.muel_ai_daily_cost AS
SELECT
  date_trunc('day', created_at) AS day,
  task_type,
  model,
  provider,
  count(*) AS calls,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(total_tokens) AS total_tokens,
  avg(latency_ms) AS avg_latency_ms,
  sum((status='error')::int) AS error_calls,
  sum((status='fallback')::int) AS fallback_calls
FROM public.muel_ai_events
WHERE created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3, 4;

REVOKE ALL ON public.muel_ai_daily_cost FROM anon, authenticated;
GRANT SELECT ON public.muel_ai_daily_cost TO service_role;
