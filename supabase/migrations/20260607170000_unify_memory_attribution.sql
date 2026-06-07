-- 메모리 귀속 통일: 회수 RPC 가 muel_chats.source_user_id(자주 NULL) 대신
-- weave_user_memories 와 동일한 메시지-metadata 귀속 규칙을 쓰도록 변경.
-- 규칙: 출처 메시지를 본인이 작성(message_id) OR 본인 단독 chat(다른 discordUserId 없음).
-- 또한 status 를 ('active','confirmed') 로 통일(교정 confirmed 도 회수).

create or replace function public.fetch_active_memories_by_user(p_user_id text)
 returns table(id uuid, content text, importance smallint, kind text, status text, created_at timestamptz)
 language sql security definer set search_path to 'public','extensions','pg_temp'
as $function$
  select e.id, e.content, e.importance, e.kind, e.status, e.created_at
  from public.muel_memory_entries e
  where coalesce(e.status,'active') in ('active','confirmed')
    and (
      exists (select 1 from public.muel_messages_v2 mv where mv.id = e.message_id and mv.metadata->>'discordUserId' = p_user_id)
      or (
        exists (select 1 from public.muel_messages_v2 mv where mv.chat_id = e.chat_id and mv.metadata->>'discordUserId' = p_user_id)
        and not exists (select 1 from public.muel_messages_v2 mv2 where mv2.chat_id = e.chat_id and mv2.metadata ? 'discordUserId' and mv2.metadata->>'discordUserId' <> p_user_id)
      )
    )
  order by e.importance desc, e.updated_at desc;
$function$;

create or replace function public.match_user_memories(p_user_id text, p_query_embedding vector, p_match_threshold double precision, p_match_count integer)
 returns table(id uuid, content text, importance smallint, kind text, similarity double precision)
 language plpgsql security definer set search_path to 'public','extensions','pg_temp'
as $function$
begin
  return query
  with ranked as (
    select e.id, e.content, e.importance, e.kind,
      (emb.embedding operator(extensions.<=>) p_query_embedding) as distance
    from public.muel_memory_entries e
    join public.muel_memory_embeddings emb on emb.memory_id = e.id
    where coalesce(e.status,'active') in ('active','confirmed')
      and (
        exists (select 1 from public.muel_messages_v2 mv where mv.id = e.message_id and mv.metadata->>'discordUserId' = p_user_id)
        or (
          exists (select 1 from public.muel_messages_v2 mv where mv.chat_id = e.chat_id and mv.metadata->>'discordUserId' = p_user_id)
          and not exists (select 1 from public.muel_messages_v2 mv2 where mv2.chat_id = e.chat_id and mv2.metadata ? 'discordUserId' and mv2.metadata->>'discordUserId' <> p_user_id)
        )
      )
    order by emb.embedding operator(extensions.<=>) p_query_embedding asc
    limit greatest(p_match_count * 4, p_match_count)
  )
  select ranked.id, ranked.content, ranked.importance, ranked.kind, (1 - ranked.distance)::float as similarity
  from ranked where (1 - ranked.distance) > p_match_threshold
  order by ranked.distance asc limit p_match_count;
end;
$function$;