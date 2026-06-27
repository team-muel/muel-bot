-- Make existing "service-role only" tables explicit in RLS instead of leaving
-- them with zero policies. This does not open client access; it documents that
-- anon/authenticated clients are denied and removes the no-policy lint.
do $$
declare
  target record;
  policy_name text;
begin
  for target in
    select * from (values
      ('legacy_archive', 'muel_conversations'),
      ('legacy_archive', 'muel_events'),
      ('legacy_archive', 'muel_messages'),
      ('public', 'gemini_operations'),
      ('public', 'gemini_webhook_configs'),
      ('public', 'gemini_webhook_events'),
      ('public', 'muel_active_channels'),
      ('public', 'muel_agent_actions'),
      ('public', 'muel_ai_events'),
      ('public', 'muel_chats'),
      ('public', 'muel_community_digests'),
      ('public', 'muel_community_signals'),
      ('public', 'muel_feedback_signals'),
      ('public', 'muel_hub_channels'),
      ('public', 'muel_jobs'),
      ('public', 'muel_messages_v2'),
      ('public', 'muel_pending_observations'),
      ('public', 'muel_proactive_configs'),
      ('public', 'muel_proactive_guild_state'),
      ('public', 'muel_profile_identities'),
      ('public', 'muel_profiles'),
      ('public', 'muel_reflection_proposals'),
      ('public', 'muel_reflection_runs'),
      ('public', 'muel_research_jobs'),
      ('public', 'muel_rolling_blocks'),
      ('public', 'muel_rolling_papers'),
      ('public', 'muel_welcome_configs'),
      ('public', 'muel_youtube_items'),
      ('public', 'service_events')
    ) as t(schema_name, table_name)
  loop
    policy_name := target.table_name || '_client_no_access';
    execute format('revoke all on table %I.%I from anon, authenticated', target.schema_name, target.table_name);
    execute format('drop policy if exists %I on %I.%I', policy_name, target.schema_name, target.table_name);
    execute format(
      'create policy %I on %I.%I for all to anon, authenticated using (false) with check (false)',
      policy_name,
      target.schema_name,
      target.table_name
    );
  end loop;
end $$;

-- Missing FK indexes reported by the performance advisor.
create index if not exists agent_got_edges_from_node_id_idx
  on public.agent_got_edges (from_node_id);
create index if not exists agent_got_edges_to_node_id_idx
  on public.agent_got_edges (to_node_id);
create index if not exists muel_agent_actions_ai_event_id_idx
  on public.muel_agent_actions (ai_event_id);
create index if not exists muel_ai_events_chat_id_idx
  on public.muel_ai_events (chat_id);
create index if not exists muel_community_digests_signal_id_idx
  on public.muel_community_digests (signal_id);
create index if not exists muel_memory_entries_message_id_idx
  on public.muel_memory_entries (message_id);
create index if not exists settings_user_id_idx
  on public.settings (user_id);

-- Keep the descriptive index and drop its duplicate.
drop index if exists public.trades_lookup;

-- Security-definer helper functions are needed for RLS recursion avoidance,
-- but they should not be directly exposed as RPC functions in the mafia schema.
-- Move the callable helpers to a private schema, update policies/views to use
-- that schema, then revoke direct execution from the exposed originals.
create schema if not exists mafia_private;
revoke all on schema mafia_private from public, anon, authenticated;
grant usage on schema mafia_private to authenticated, service_role;

create or replace function mafia_private.is_match_participant(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mafia, public, pg_temp
as $function$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
  );
$function$;

create or replace function mafia_private.is_dead_participant(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mafia, public, pg_temp
as $function$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
      and mp.alive = false
  );
$function$;

create or replace function mafia_private.is_demon_circle_member(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mafia, public, pg_temp
as $function$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
      and coalesce((mp.engine_state->>'circleChat')::boolean, false)
  );
$function$;

create or replace function mafia_private.is_demon_circle_known(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = mafia, public, pg_temp
as $function$
  select exists (
    select 1
    from mafia.match_players mp
    where mp.match_id = target_match_id
      and mp.user_id = mafia.current_game_user_id()
      and coalesce((mp.engine_state->>'circleKnown')::boolean, false)
  );
$function$;

revoke all on function mafia_private.is_match_participant(uuid) from public, anon;
revoke all on function mafia_private.is_dead_participant(uuid) from public, anon;
revoke all on function mafia_private.is_demon_circle_member(uuid) from public, anon;
revoke all on function mafia_private.is_demon_circle_known(uuid) from public, anon;
grant execute on function mafia_private.is_match_participant(uuid) to authenticated, service_role;
grant execute on function mafia_private.is_dead_participant(uuid) to authenticated, service_role;
grant execute on function mafia_private.is_demon_circle_member(uuid) to authenticated, service_role;
grant execute on function mafia_private.is_demon_circle_known(uuid) to authenticated, service_role;

drop policy if exists mafia_match_chats_dead_read on mafia.match_chats;
drop policy if exists mafia_match_chats_demon_circle_read on mafia.match_chats;
drop policy if exists mafia_match_chats_town_read on mafia.match_chats;
create policy mafia_match_chats_visible_read on mafia.match_chats
  for select to authenticated
  using (
    (channel = 'town' and mafia_private.is_match_participant(match_id))
    or (channel = 'dead' and mafia_private.is_dead_participant(match_id))
    or (channel = 'demon_circle' and mafia_private.is_demon_circle_member(match_id))
  );

drop policy if exists mafia_match_events_visible_read on mafia.match_events;
create policy mafia_match_events_visible_read on mafia.match_events
  for select to authenticated
  using (
    (visibility = 'public' and mafia_private.is_match_participant(match_id))
    or (visibility = 'private' and recipient_user_id = mafia.current_game_user_id())
  );

drop policy if exists mafia_match_phases_participant_read on mafia.match_phases;
create policy mafia_match_phases_participant_read on mafia.match_phases
  for select to authenticated
  using (mafia_private.is_match_participant(match_id));

drop policy if exists mafia_match_players_participant_read on mafia.match_players;
create policy mafia_match_players_participant_read on mafia.match_players
  for select to authenticated
  using (mafia_private.is_match_participant(match_id));

drop policy if exists mafia_matches_participant_read on mafia.matches;
create policy mafia_matches_participant_read on mafia.matches
  for select to authenticated
  using (mafia_private.is_match_participant(id));

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
    when user_id = mafia.current_game_user_id() then coalesce(((engine_state -> 'counters') ->> 'pendantTargetBonus')::integer, 0)
    else null
  end as target_bonus
from mafia.match_players mp;

grant select on mafia.match_players_visible to authenticated, service_role;

revoke execute on function mafia.is_match_participant(uuid) from public, anon, authenticated;
revoke execute on function mafia.is_dead_participant(uuid) from public, anon, authenticated;
revoke execute on function mafia.is_demon_circle_member(uuid) from public, anon, authenticated;
revoke execute on function mafia.is_demon_circle_known(uuid) from public, anon, authenticated;
grant execute on function mafia.is_match_participant(uuid) to service_role;
grant execute on function mafia.is_dead_participant(uuid) to service_role;
grant execute on function mafia.is_demon_circle_member(uuid) to service_role;
grant execute on function mafia.is_demon_circle_known(uuid) to service_role;

alter function mafia.next_table_number(text, text)
  set search_path = mafia, public, pg_temp;

-- Collapse duplicate authenticated SELECT policies while preserving public
-- readable rows and owner-readable private rows.
drop policy if exists "Public dreams are readable" on public.dreams;
drop policy if exists "Users can read own dreams" on public.dreams;
create policy "Anon can read public dreams" on public.dreams
  for select to anon
  using (visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility]));
create policy "Authenticated can read visible or own dreams" on public.dreams
  for select to authenticated
  using (
    visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility])
    or user_id = (select auth.uid())
  );

drop policy if exists "Public dream connections are readable" on public.dream_connections;
drop policy if exists "Users can read own dream connections" on public.dream_connections;
create policy "Anon can read public dream connections" on public.dream_connections
  for select to anon
  using (
    exists (
      select 1
      from public.dreams a
      join public.dreams b on b.id = dream_connections.dream_b
      where a.id = dream_connections.dream_a
        and a.visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility])
        and b.visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility])
    )
  );
create policy "Authenticated can read visible or own dream connections" on public.dream_connections
  for select to authenticated
  using (
    exists (
      select 1
      from public.dreams a
      join public.dreams b on b.id = dream_connections.dream_b
      where a.id = dream_connections.dream_a
        and (
          (
            a.visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility])
            and b.visibility = any (array['anonymous'::dream_visibility, 'public'::dream_visibility])
          )
          or (a.user_id = (select auth.uid()) and b.user_id = (select auth.uid()))
        )
    )
  );
