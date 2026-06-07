-- Weave 재포지셔닝: "Muel이 보는 나" — 사용자별 메모리 조회 RPC.
-- 프라이버시: 메모리를 (a) 출처 메시지를 본인이 쓴 경우 또는 (b) 본인 단독 chat 인 경우에만
-- 귀속(다중 사용자 chat 의 Muel-답변 기반 메모리는 누구에게도 노출하지 않음).
-- Next API 라우트(/api/weave/me)가 service_role 로 호출 — 요청자의 discord uid 를 넘긴다.

create or replace function public.weave_user_memories(uid text)
returns table (
  id uuid, kind text, content text, importance smallint, confidence real,
  status text, created_at timestamptz, source_channel text
)
language sql
stable
security definer
set search_path = public
as $$
  select me.id, me.kind, me.content, me.importance, me.confidence,
         coalesce(me.status, 'active') as status, me.created_at,
         (select mv.metadata->>'discordChannelId' from muel_messages_v2 mv where mv.id = me.message_id) as source_channel
  from muel_memory_entries me
  where coalesce(me.status, 'active') <> 'deleted'
    and (
      exists (select 1 from muel_messages_v2 mv where mv.id = me.message_id and mv.metadata->>'discordUserId' = uid)
      or (
        exists (select 1 from muel_messages_v2 mv where mv.chat_id = me.chat_id and mv.metadata->>'discordUserId' = uid)
        and not exists (
          select 1 from muel_messages_v2 mv2
          where mv2.chat_id = me.chat_id and mv2.metadata ? 'discordUserId'
            and mv2.metadata->>'discordUserId' <> uid
        )
      )
    )
  order by me.importance desc nulls last, me.created_at desc;
$$;

revoke all on function public.weave_user_memories(text) from anon, authenticated;
grant execute on function public.weave_user_memories(text) to service_role;
