-- 20260528111135_extend_muel_jobs_type_for_research_poll.sql
-- Split long AI-Q research delivery into short submit and polling jobs so the
-- single app worker does not hold a muel_jobs lock for 15-30 minutes.

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
    'summarize_community_flow',
    'research_user_dm',
    'research_user_dm_poll'
  ));
