-- Gomdori W4 v1: 신규 직업/액션 허용 + W1b 의심투표 제약 보정 + 가인(조력자) faction 기반 demon-circle.
--
-- 1) 신규 직업: rainer(라이너), romaz(로마즈), gain(가인). 신규 액션: romaz_suspect.
-- 2) W1b 보정: 라이브 DB에 'suspect' 액션 / 'night_suspect' 페이즈 제약이 누락되어 있어
--    (코드는 배포됐으나 제약 미반영) 둘째 밤 의심투표가 제약 위반으로 실패함 — 함께 보정.
-- 3) 가인은 role='gain', faction='demon' 인 조력자. demon-circle 멤버십/공개를 role 기반에서
--    faction 기반으로 바꿔 가인이 동료 공개·악마 채팅에 정상 포함되도록 함.

alter table mafia.match_players drop constraint if exists match_players_role_check;
alter table mafia.match_players add constraint match_players_role_check
  check (role in ('citizen', 'doctor', 'police', 'demon', 'helper', 'rainer', 'romaz', 'gain'));

alter table mafia.match_actions drop constraint if exists match_actions_action_type_check;
alter table mafia.match_actions add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill', 'doctor_heal', 'police_investigate', 'vote',
    'verdict_approve', 'verdict_reject', 'suspect', 'romaz_suspect'
  ));

alter table mafia.match_phases drop constraint if exists match_phases_phase_type_check;
alter table mafia.match_phases add constraint match_phases_phase_type_check
  check (phase_type in (
    'role_assign', 'night', 'night_suspect', 'night_resolve', 'day', 'vote', 'verdict', 'end'
  ));

-- demon-circle 멤버십: faction 기반 (가인 등 조력자 role 포함).
create or replace function mafia.is_demon_circle_member(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mafia, public, pg_temp
as $$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
      and mp.faction = 'demon'
  );
$$;

-- visible 뷰: 동료(악마팀) role/faction 공개도 faction 기반으로.
create or replace view mafia.match_players_visible
with (security_invoker = true) as
select
  mp.match_id,
  mp.user_id,
  mp.display_name,
  mp.avatar_url,
  mp.alive,
  mp.ready,
  mp.is_host,
  mp.joined_at,
  mp.last_seen_at,
  mp.eliminated_at,
  mp.eliminated_phase_number,
  mp.eliminated_cause,
  case
    when mp.user_id = mafia.current_game_user_id() then mp.role
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended' then mp.role
    when mp.faction = 'demon' and mafia.is_demon_circle_member(mp.match_id) then mp.role
    else null
  end as role,
  case
    when mp.user_id = mafia.current_game_user_id() then mp.faction
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended' then mp.faction
    when mp.faction = 'demon' and mafia.is_demon_circle_member(mp.match_id) then mp.faction
    else null
  end as faction
from mafia.match_players mp;

grant select on mafia.match_players_visible to authenticated;
