-- 20260524001300_create_muel_research_lane_views.sql
-- Research lane summary, mirrors muel_ai_lane_summary_7d shape so research can
-- be queried side-by-side with chat/router/extract/summary lanes.

CREATE OR REPLACE VIEW public.muel_research_lane_summary_7d AS
SELECT
  trigger_source,
  status,
  count(*) AS jobs,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(total_tokens) AS total_tokens,
  sum(estimated_cost_usd) AS estimated_cost_usd,
  avg(duration_ms)::numeric(10,2) AS avg_duration_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::numeric(10,2) AS p50_duration_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric(10,2) AS p95_duration_ms,
  sum(CASE WHEN delivery_channel = 'dm' THEN 1 ELSE 0 END) AS delivered_dm,
  sum(CASE WHEN delivery_channel IN ('fallback_ephemeral','fallback_thread') THEN 1 ELSE 0 END) AS delivered_fallback
FROM public.muel_research_jobs
WHERE created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY trigger_source, status;

REVOKE ALL ON public.muel_research_lane_summary_7d FROM anon, authenticated;
GRANT SELECT ON public.muel_research_lane_summary_7d TO service_role;

-- Per-user / per-origin enrichment usage view.
CREATE OR REPLACE VIEW public.muel_research_user_usage_7d AS
SELECT
  requester_user_id,
  origin_table,
  count(*) AS enrichment_count,
  count(DISTINCT origin_id) AS distinct_items_enriched,
  sum(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  sum(CASE WHEN status IN ('failure','timeout') THEN 1 ELSE 0 END) AS failure_count,
  max(created_at) AS last_enrichment_at
FROM public.muel_research_jobs
WHERE created_at >= now() - interval '7 days'
  AND trigger_source = 'user_button_dm'
GROUP BY 1, 2
ORDER BY enrichment_count DESC;

REVOKE ALL ON public.muel_research_user_usage_7d FROM anon, authenticated;
GRANT SELECT ON public.muel_research_user_usage_7d TO service_role;
