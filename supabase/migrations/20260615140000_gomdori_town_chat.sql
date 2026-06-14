-- 공용(낮) 채팅 + 영혼(사망자) 채팅 (2026-06-15)
--
-- 정본: 채팅은 Feign식 중앙 채팅. 낮(day)엔 생존자 전원이 'town' 채널에서 발화하고
-- 모든 참가자가 읽는다. 사망자는 town 을 읽기만 하고, 자기들끼리 'dead'(영혼) 채널에서
-- 발화한다(산 자는 못 봄). 밤은 기존대로 'demon_circle' 회로원 밀회만.
--
-- 발화 검증/채널 결정은 match-chat(서비스롤)이 한다 — 여기선 채널 허용·읽기 RLS 만.

-- 1) channel 허용값 확장: demon_circle + town + dead.
alter table mafia.match_chats drop constraint if exists match_chats_channel_check;
alter table mafia.match_chats
  add constraint match_chats_channel_check
  check (channel in ('demon_circle', 'town', 'dead'));

-- 2) 사망 참가자 판별(영혼 채팅 읽기용).
create or replace function mafia.is_dead_participant(target_match_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'mafia', 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
      and mp.alive = false
  );
$$;

revoke all on function mafia.is_dead_participant(uuid) from public;
grant execute on function mafia.is_dead_participant(uuid) to authenticated;

-- 3) 읽기 RLS — town 은 참가자 전원, dead 는 사망자만. demon_circle 정책은 기존 유지.
drop policy if exists mafia_match_chats_town_read on mafia.match_chats;
create policy mafia_match_chats_town_read on mafia.match_chats
  for select
  to authenticated
  using (
    channel = 'town'
    and mafia.is_match_participant(match_id)
  );

drop policy if exists mafia_match_chats_dead_read on mafia.match_chats;
create policy mafia_match_chats_dead_read on mafia.match_chats
  for select
  to authenticated
  using (
    channel = 'dead'
    and mafia.is_dead_participant(match_id)
  );
