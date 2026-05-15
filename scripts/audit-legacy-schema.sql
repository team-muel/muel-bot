-- 1. Table Row Counts (To identify if there's actual data worth keeping)
SELECT
  schemaname,
  relname as table_name,
  n_live_tup as estimated_rows
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC;

-- 2. Check if any functions reference these legacy tables
SELECT
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_functiondef(p.oid) as definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND pg_get_functiondef(p.oid) ~* '(muel_messages|muel_conversations|memory_items|obsidian_cache|agent_sessions|retrieval_eval)';

-- 3. Check view / materialized view dependencies
SELECT
  table_schema,
  table_name,
  view_definition
FROM information_schema.views
WHERE view_definition ~* '(muel_messages|muel_conversations|memory_items|obsidian_cache|agent_sessions|retrieval_eval)';

-- 4. Check trigger dependencies
SELECT
  event_object_table,
  trigger_name,
  action_statement
FROM information_schema.triggers
WHERE action_statement ~* '(muel_messages|muel_conversations|memory_items|obsidian_cache|agent_sessions|retrieval_eval)';

-- 5. Function list backup
SELECT
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) as definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';
