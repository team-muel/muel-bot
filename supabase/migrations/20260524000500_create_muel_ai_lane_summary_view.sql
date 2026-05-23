-- 20260524000500_create_muel_ai_lane_summary_view.sql
-- Item 7 — rolling 7-day per-lane summary with latency percentiles. Useful for
-- comparing chat / router / extract / summary cost shapes without scanning the
-- whole muel_ai_events table.

CREATE OR REPLACE VIEW public.muel_ai_lane_summary_7d AS
SELECT
  task_type,
  count(*) AS calls,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(total_tokens) AS total_tokens,
  avg(latency_ms)::numeric(10,2) AS avg_latency_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::numeric(10,2) AS p50_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric(10,2) AS p95_latency_ms,
  sum((status='error')::int) AS error_calls,
  sum((status='fallback')::int) AS fallback_calls
FROM public.muel_ai_events
WHERE created_at >= now() - interval '7 days'
  AND task_type IS NOT NULL
GROUP BY 1
ORDER BY total_tokens DESC NULLS LAST;

REVOKE ALL ON public.muel_ai_lane_summary_7d FROM anon, authenticated;
GRANT SELECT ON public.muel_ai_lane_summary_7d TO service_role;
