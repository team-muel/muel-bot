-- Gomdori W1b/W4 runtime DB contract.
--
-- #52 added W4 engine roles and #46 added the matching UI, but the live DB
-- still had Phase 1 check constraints. Keep DB-facing factions as angel/demon;
-- "gain" is a demon-team role whose investigation behavior is role-based.

alter table mafia.matches
  drop constraint if exists matches_status_check;

alter table mafia.matches
  add constraint matches_status_check
  check (status in (
    'lobby',
    'role_assign',
    'night',
    'night_suspect',
    'night_resolve',
    'day',
    'vote',
    'verdict',
    'ended',
    'aborted'
  ));

alter table mafia.match_phases
  drop constraint if exists match_phases_phase_type_check;

alter table mafia.match_phases
  add constraint match_phases_phase_type_check
  check (phase_type in (
    'role_assign',
    'night',
    'night_suspect',
    'night_resolve',
    'day',
    'vote',
    'verdict',
    'end'
  ));

alter table mafia.match_players
  drop constraint if exists match_players_role_check;

alter table mafia.match_players
  add constraint match_players_role_check
  check (role in (
    'citizen',
    'doctor',
    'police',
    'demon',
    'helper',
    'rainer',
    'romaz',
    'gain'
  ));

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill',
    'doctor_heal',
    'police_investigate',
    'romaz_suspect',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));

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

revoke all on function mafia.is_demon_circle_member(uuid) from public;
grant execute on function mafia.is_demon_circle_member(uuid) to authenticated;

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
