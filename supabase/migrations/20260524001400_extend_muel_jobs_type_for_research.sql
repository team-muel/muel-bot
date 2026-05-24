-- 20260524001400_extend_muel_jobs_type_for_research.sql
-- Allow 'research_user_dm' jobs so jobWorker can process AI-Q enrichment.

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
    'research_user_dm'
  ));
