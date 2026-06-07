-- Weave 서버 뷰: 비개인 커뮤니티 지표(사용자별 상호작용 수·최근, 전체 totals).
-- 메모리 '내용'은 노출하지 않음 — 카운트/이름/활동량만. Next /api/weave/server 가 service_role 로 호출.
create or replace function public.weave_server_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users', (
      select coalesce(jsonb_agg(u order by (u->>'messages')::int desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'userId', mv.metadata->>'discordUserId',
          'username', max(mv.metadata->>'discordUsername'),
          'messages', count(*),
          'lastSeen', max(mv.created_at)
        ) u
        from muel_messages_v2 mv
        where mv.metadata ? 'discordUserId'
        group by mv.metadata->>'discordUserId'
      ) t
    ),
    'totals', jsonb_build_object(
      'memories', (select count(*) from muel_memory_entries where coalesce(status, 'active') <> 'deleted'),
      'profiles', (select count(*) from muel_profiles),
      'messages', (select count(*) from muel_messages_v2),
      'contributions', (select count(*) from muel_agent_actions)
    )
  );
$$;

revoke all on function public.weave_server_overview() from anon, authenticated;
grant execute on function public.weave_server_overview() to service_role;
