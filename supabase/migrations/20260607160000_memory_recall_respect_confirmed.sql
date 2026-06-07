-- Weave 교정 루프 반영: 메모리 회수가 'disputed'(틀림)는 제외하되 'confirmed'(맞음)는 유지.
-- 기존엔 status='active' 만 회수 → 교정으로 confirmed 된 기억이 회수에서 빠지는 문제.
-- status in ('active','confirmed') 로 변경. disputed/archived/deleted 는 자연 제외.

CREATE OR REPLACE FUNCTION public.fetch_active_memories_by_user(p_user_id text)
 RETURNS TABLE(id uuid, content text, importance smallint, kind text, status text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT e.id, e.content, e.importance, e.kind, e.status, e.created_at
  FROM public.muel_memory_entries e
  JOIN public.muel_chats c ON e.chat_id = c.id
  WHERE c.source_user_id = p_user_id
    AND e.status IN ('active', 'confirmed')
  ORDER BY e.importance DESC, e.updated_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.match_user_memories(p_user_id text, p_query_embedding vector, p_match_threshold double precision, p_match_count integer)
 RETURNS TABLE(id uuid, content text, importance smallint, kind text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT e.id, e.content, e.importance, e.kind,
      (emb.embedding OPERATOR(extensions.<=>) p_query_embedding) AS distance
    FROM public.muel_memory_entries e
    JOIN public.muel_chats c ON e.chat_id = c.id
    JOIN public.muel_memory_embeddings emb ON emb.memory_id = e.id
    WHERE c.source_user_id = p_user_id
      AND e.status IN ('active', 'confirmed')
    ORDER BY emb.embedding OPERATOR(extensions.<=>) p_query_embedding ASC
    LIMIT GREATEST(p_match_count * 4, p_match_count)
  )
  SELECT ranked.id, ranked.content, ranked.importance, ranked.kind,
    (1 - ranked.distance)::float AS similarity
  FROM ranked
  WHERE (1 - ranked.distance) > p_match_threshold
  ORDER BY ranked.distance ASC
  LIMIT p_match_count;
END;
$function$;
