-- 접선 회로 (2026-06-12, 정본 — 조력자 패시브가 결정):
--
-- 기본값: 악마와 조력자는 서로 모른 채 시작한다. 가인(밤2까지)·로건(영구)만
-- 악마와 접선(채팅·정체 공개). 팬텀이 악마면 접선 불가 — 상호 정체 통지만.
-- 타락자(corrupted)는 회로에 합류하지 않는다 (faction 기준이 아니라 플래그 기준이
-- 되면서 자동 충족 — 변환으로는 circleChat/circleKnown 이 생기지 않는다).
--
-- engine_state 플래그 (phase-advance finalizeRoleSelection 이 심는다):
--   circleChat  = 채팅 회로 (가인은 밤2 종료 시 phase-advance 가 끈다)
--   circleKnown = 정체 인지 (영구 — 뷰의 회로 노출 조건)

-- 1) 채팅 회로 멤버십 — faction='demon' 전원에서 circleChat 플래그 보유자로.
create or replace function mafia.is_demon_circle_member(target_match_id uuid)
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
      and coalesce((mp.engine_state->>'circleChat')::boolean, false)
  );
$$;

-- 2) 정체 인지(영구) — 뷰의 회로 노출 조건용. 채팅이 만료(가인)돼도 정체 인지는 남는다.
create or replace function mafia.is_demon_circle_known(target_match_id uuid)
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
      and coalesce((mp.engine_state->>'circleKnown')::boolean, false)
  );
$$;

-- 3) 뷰: 회로 노출 조건을 is_demon_circle_known 으로 + 본인 전용 circle_chat 컬럼 추가
--    (프론트 NightPhase 가 악마 채팅 UI 를 여는 신호). 유효 직업 노출(20260612100000)은 유지.
create or replace view mafia.match_players_visible as
select
  match_id,
  user_id,
  display_name,
  avatar_url,
  alive,
  ready,
  is_host,
  joined_at,
  last_seen_at,
  eliminated_at,
  eliminated_phase_number,
  eliminated_cause,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce(engine_state->>'currentRole', role)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended'
      then coalesce(engine_state->>'currentRole', role)
    when faction = 'demon' and mafia.is_demon_circle_known(match_id)
      then coalesce(engine_state->>'currentRole', role)
    else null::text
  end as role,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce(engine_state->>'currentFaction', faction)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended'
      then coalesce(engine_state->>'currentFaction', faction)
    when faction = 'demon' and mafia.is_demon_circle_known(match_id)
      then coalesce(engine_state->>'currentFaction', faction)
    else null::text
  end as faction,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce((engine_state->>'circleChat')::boolean, false)
    else null::boolean
  end as circle_chat
from mafia.match_players mp;
