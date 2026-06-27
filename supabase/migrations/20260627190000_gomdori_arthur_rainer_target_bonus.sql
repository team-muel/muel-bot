-- Gomdori 아서 잔불 대검 / 라이너 거친 포효·강한 의지 동적 멀티타깃 UI 노출 (2026-06-27)
--
-- 엔진은 이미 다중 대상을 수용한다(arthur_emberblade=emberTargets, rainer_roar=roarBonus,
-- rainer_resolve=resolveBonus; ActiveAbility.targetCountCounter + match-action-core effectiveTargetCount).
-- 남은 것은 클라가 "내 동적 지정 한도"를 알아 멀티선택 UI 를 띄우는 것 — match_players_visible 뷰의
-- target_bonus(본인 전용)를 로건 pendantTargetBonus 만이 아니라 emberTargets/roarBonus/resolveBonus
-- 까지 합산해 노출한다. 한 역할은 자기 카운터만 비-0 이라(상호배타) 합산이 곧 단일 보너스다.
--
-- 현재 def(advisor 20260627014902, security_invoker=true) 를 그대로 보존하고 target_bonus 식만 확장.
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
  end as target_bonus
from mafia.match_players mp;

grant select on mafia.match_players_visible to authenticated, service_role;
