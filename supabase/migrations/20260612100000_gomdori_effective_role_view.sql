-- 유효 직업/진영 노출 (2026-06-12, 직업 도입 — 변환 플레이 가능화)
--
-- 문제: match_players_visible 이 DB role/faction 컬럼만 노출 → 게임 내 변환
-- (메피스토 낙인 재배정 rebranded / 루나 타락 corrupted / 파스아 전향 converted)
-- 후에도 당사자 프로필·밤 능력 UI 가 옛 직업 기준으로 남아 변환 메커닉이
-- 사실상 플레이 불가였다.
--
-- 해결: 노출되는 role/faction 을 유효값으로 — engine_state.currentRole /
-- currentFaction 이 있으면 그것을 (엔진 playerStateFromRows·match-action
-- effectiveRole 과 동일 규칙). 노출 *조건*(본인/종료/악마 회로)은 기존 그대로.
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
    when faction = 'demon' and mafia.is_demon_circle_member(match_id)
      then coalesce(engine_state->>'currentRole', role)
    else null::text
  end as role,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce(engine_state->>'currentFaction', faction)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended'
      then coalesce(engine_state->>'currentFaction', faction)
    when faction = 'demon' and mafia.is_demon_circle_member(match_id)
      then coalesce(engine_state->>'currentFaction', faction)
    else null::text
  end as faction
from mafia.match_players mp;
