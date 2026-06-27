-- Gomdori 루루 소나타 '전원 능력 지정 +1' UI 노출 (2026-06-27)
--
-- 엔진은 소나타 발동 시 전원 dayTargetBonus=1(1일) 을 세팅하고 effectiveTargetCount 가 모든 능력의
-- 지정 한도에 더한다(canon [천사]30). 클라가 멀티선택 UI 를 띄우려면 본인 dayTargetBonus 를 알아야
-- 하므로 match_players_visible 에 day_target_bonus 컬럼을 append 한다(본인 전용·타인 null·RLS 안전).
-- target_bonus(역할별 능력 보너스)와 별개 — day_target_bonus 는 전 능력에 적용되는 전역 1일 보너스.
--
-- 현재 def(20260627190000) 보존 + day_target_bonus 컬럼만 끝에 추가.
create or replace view mafia.match_players_visible
with (security_invoker = true)
as
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
    when user_id = mafia.current_game_user_id() then coalesce(engine_state ->> 'currentRole', role)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended' then coalesce(engine_state ->> 'currentRole', role)
    when faction = 'demon' and mafia_private.is_demon_circle_known(match_id) then coalesce(engine_state ->> 'currentRole', role)
    else null
  end as role,
  case
    when user_id = mafia.current_game_user_id() then coalesce(engine_state ->> 'currentFaction', faction)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended' then coalesce(engine_state ->> 'currentFaction', faction)
    when faction = 'demon' and mafia_private.is_demon_circle_known(match_id) then coalesce(engine_state ->> 'currentFaction', faction)
    else null
  end as faction,
  case
    when user_id = mafia.current_game_user_id() then coalesce((engine_state ->> 'circleChat')::boolean, false)
    else null
  end as circle_chat,
  is_ai,
  ai_provider,
  case
    when user_id = mafia.current_game_user_id() then
      coalesce(((engine_state -> 'counters') ->> 'pendantTargetBonus')::integer, 0)
      + coalesce(((engine_state -> 'counters') ->> 'emberTargets')::integer, 0)
      + coalesce(((engine_state -> 'counters') ->> 'roarBonus')::integer, 0)
      + coalesce(((engine_state -> 'counters') ->> 'resolveBonus')::integer, 0)
    else null
  end as target_bonus,
  case
    when user_id = mafia.current_game_user_id() then coalesce(((engine_state -> 'counters') ->> 'dayTargetBonus')::integer, 0)
    else null
  end as day_target_bonus
from mafia.match_players mp;

grant select on mafia.match_players_visible to authenticated, service_role;
