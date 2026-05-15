-- Archive legacy schemas and tables instead of dropping (Archive-First Strategy)

CREATE SCHEMA IF NOT EXISTS legacy_archive;

-- 1. Archive old Agent & Tool learning system
ALTER TABLE IF EXISTS public.agent_privacy_gate_samples SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.agent_sessions SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.agent_skill_catalog SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.agent_steps SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.agent_tool_learning_logs SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.agent_workflow_profiles SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.intents SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.research_presets SET SCHEMA legacy_archive;

-- 2. Archive old RAG, Eval, and Obsidian tables
ALTER TABLE IF EXISTS public.obsidian_cache SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.memory_items SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.memory_sources SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.retrieval_eval_results SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.retrieval_eval_runs SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.retrieval_eval_sets SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.retrieval_eval_targets SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.retrieval_ranker_active_profiles SET SCHEMA legacy_archive;

-- 3. Archive legacy Muel V1 tables
ALTER TABLE IF EXISTS public.muel_events SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.muel_messages SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.muel_conversations SET SCHEMA legacy_archive;

-- 4. Do not drop functions yet (Requires audit first)
-- Functions like cleanup_agent_llm_call_logs, match_dreams, search_memory_items_hybrid, match_muel_messages
-- will be kept in public for now until dependencies are verified.
