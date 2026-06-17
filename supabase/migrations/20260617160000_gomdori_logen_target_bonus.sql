-- Gomdori 로건 부서진 펜던트 멀티타깃 UI 노출 (2026-06-17)
--
-- 엔진은 로건 패시브로 악마팀 펜던트 3+ 시 logen_nullify 의 지정 대상을 +2 한다
-- (engine_state.counters.pendantTargetBonus, ActiveAbility.targetCountCounter). 백엔드
-- 검증(match-action-core)도 effectiveTargetCount 로 이미 다중 대상을 수용한다. 남은 것은
-- 클라가 "내 동적 지정 한도"를 알아 멀티선택 UI 를 띄우는 것 — match_players_visible 뷰에
-- 본인 한정 target_bonus 컬럼을 append 한다(타인 노출 없음, RLS 안전).
--
-- create or replace view 는 신규 컬럼 끝 append 만 허용하므로 20260615120000 정의를 그대로
-- 보존하고 target_bonus 만 맨 끝에 추가한다.
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
  end as circle_chat,
  is_ai,
  ai_provider,
  -- 본인 전용: 동적 멀티타깃 보너스(로건 펜던트 등). 타인은 null — 능력 한도는 비밀.
  case
    when user_id = mafia.current_game_user_id()
      then coalesce((engine_state->'counters'->>'pendantTargetBonus')::int, 0)
    else null::int
  end as target_bonus
from mafia.match_players mp;
