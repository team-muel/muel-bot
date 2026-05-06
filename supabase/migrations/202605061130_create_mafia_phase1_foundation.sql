-- Gomdori Mafia Phase 1 foundation.
--
-- Collision note:
-- The existing Supabase project already has public.users with text primary keys
-- used by the current Muel bot tables. Do not create the Phase 1 game tables in
-- public without a rename plan. This migration keeps the game foundation in the
-- dedicated mafia schema so the internal game user id can remain uuid.
--
-- If this later needs to be exposed through Supabase Data API, add "mafia" to
-- the project's exposed schemas in the dashboard and keep RLS enabled.
--
-- pg_cron is intentionally not enabled here. Scheduler functions and cron jobs
-- belong to migration 002, during the game-loop step.

create schema if not exists mafia;

create extension if not exists pgcrypto with schema extensions;

create table if not exists mafia.users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mafia.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references mafia.users(id) on delete cascade,
  provider text not null check (provider in ('discord', 'toss')),
  provider_user_id text not null,
  username text,
  avatar_url text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);

create table if not exists mafia.matches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'lobby'
    check (status in ('lobby', 'role_assign', 'night', 'night_resolve', 'day', 'vote', 'verdict', 'ended', 'aborted')),
  host_user_id uuid references mafia.users(id),
  context_type text not null default 'discord_voice'
    check (context_type in ('discord_voice', 'toss_group', 'standalone')),
  context_id text,
  notification_kind text not null default 'none'
    check (notification_kind in ('discord_channel', 'toss_push', 'none')),
  notification_id text,
  max_players int not null default 12 check (max_players between 5 and 12),
  winner text check (winner in ('angels', 'demons')),
  abort_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

create table if not exists mafia.match_players (
  match_id uuid not null references mafia.matches(id) on delete cascade,
  user_id uuid not null references mafia.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  role text check (role in ('citizen', 'doctor', 'police', 'demon', 'helper')),
  faction text check (faction in ('angel', 'demon')),
  alive boolean not null default true,
  ready boolean not null default false,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz,
  eliminated_at timestamptz,
  eliminated_phase_number int,
  eliminated_cause text check (eliminated_cause in ('night_kill', 'vote', 'abort')),
  primary key (match_id, user_id)
);

create table if not exists mafia.match_phases (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references mafia.matches(id) on delete cascade,
  phase_number int not null,
  phase_type text not null
    check (phase_type in ('role_assign', 'night', 'night_resolve', 'day', 'vote', 'verdict', 'end')),
  started_at timestamptz not null default now(),
  expected_ended_at timestamptz not null,
  ended_at timestamptz,
  unique (match_id, phase_number, phase_type)
);

create table if not exists mafia.match_actions (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references mafia.match_phases(id) on delete cascade,
  match_id uuid not null references mafia.matches(id) on delete cascade,
  actor_user_id uuid not null references mafia.users(id),
  action_type text not null
    check (action_type in ('demon_kill', 'doctor_heal', 'police_investigate', 'vote')),
  target_user_id uuid references mafia.users(id),
  result jsonb,
  submitted_at timestamptz not null default now(),
  unique (phase_id, actor_user_id, action_type)
);

create table if not exists mafia.match_chats (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references mafia.matches(id) on delete cascade,
  phase_id uuid references mafia.match_phases(id) on delete set null,
  channel text not null check (channel in ('demon_circle')),
  sender_user_id uuid not null references mafia.users(id),
  message text not null check (length(message) <= 2000),
  created_at timestamptz not null default now()
);

create table if not exists mafia.match_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references mafia.matches(id) on delete cascade,
  phase_id uuid references mafia.match_phases(id) on delete set null,
  event_type text not null,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  recipient_user_id uuid references mafia.users(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (visibility = 'private' and recipient_user_id is not null)
    or (visibility = 'public')
  )
);

create index if not exists mafia_identities_user_id_idx on mafia.identities (user_id);
create index if not exists mafia_matches_host_user_id_idx on mafia.matches (host_user_id);
create index if not exists mafia_matches_context_idx on mafia.matches (context_type, context_id) where status <> 'ended';
create index if not exists mafia_match_players_user_id_idx on mafia.match_players (user_id);
create index if not exists mafia_match_players_match_id_idx on mafia.match_players (match_id);
create index if not exists mafia_match_phases_match_id_phase_number_idx on mafia.match_phases (match_id, phase_number);
create index if not exists mafia_match_actions_phase_id_idx on mafia.match_actions (phase_id);
create index if not exists mafia_match_actions_actor_user_id_idx on mafia.match_actions (actor_user_id);
create index if not exists mafia_match_actions_target_user_id_idx on mafia.match_actions (target_user_id);
create index if not exists mafia_match_actions_match_actor_idx on mafia.match_actions (match_id, actor_user_id);
create index if not exists mafia_match_chats_match_created_idx on mafia.match_chats (match_id, created_at);
create index if not exists mafia_match_chats_phase_id_idx on mafia.match_chats (phase_id);
create index if not exists mafia_match_chats_sender_user_id_idx on mafia.match_chats (sender_user_id);
create index if not exists mafia_match_events_match_created_idx on mafia.match_events (match_id, created_at);
create index if not exists mafia_match_events_phase_id_idx on mafia.match_events (phase_id);
create index if not exists mafia_match_events_private_recipient_idx on mafia.match_events (recipient_user_id) where visibility = 'private';

alter table mafia.users enable row level security;
alter table mafia.identities enable row level security;
alter table mafia.matches enable row level security;
alter table mafia.match_players enable row level security;
alter table mafia.match_phases enable row level security;
alter table mafia.match_actions enable row level security;
alter table mafia.match_chats enable row level security;
alter table mafia.match_events enable row level security;

create or replace function mafia.current_game_user_id()
returns uuid
language sql
stable
set search_path = pg_temp
as $$
  select nullif(auth.jwt()->>'sub', '')::uuid
$$;

create or replace function mafia.is_match_participant(target_match_id uuid)
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
  );
$$;

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
      and mp.role in ('demon', 'helper')
  );
$$;

revoke all on function mafia.is_match_participant(uuid) from public;
revoke all on function mafia.is_demon_circle_member(uuid) from public;
grant execute on function mafia.is_match_participant(uuid) to authenticated;
grant execute on function mafia.is_demon_circle_member(uuid) to authenticated;

drop policy if exists mafia_users_self_read on mafia.users;
create policy mafia_users_self_read on mafia.users
  for select
  to authenticated
  using (id = mafia.current_game_user_id());

drop policy if exists mafia_identities_self_read on mafia.identities;
create policy mafia_identities_self_read on mafia.identities
  for select
  to authenticated
  using (user_id = mafia.current_game_user_id());

drop policy if exists mafia_matches_participant_read on mafia.matches;
create policy mafia_matches_participant_read on mafia.matches
  for select
  to authenticated
  using (mafia.is_match_participant(id));

drop policy if exists mafia_match_players_participant_read on mafia.match_players;
create policy mafia_match_players_participant_read on mafia.match_players
  for select
  to authenticated
  using (mafia.is_match_participant(match_id));

drop policy if exists mafia_match_phases_participant_read on mafia.match_phases;
create policy mafia_match_phases_participant_read on mafia.match_phases
  for select
  to authenticated
  using (mafia.is_match_participant(match_id));

drop policy if exists mafia_match_actions_self_read on mafia.match_actions;
create policy mafia_match_actions_self_read on mafia.match_actions
  for select
  to authenticated
  using (actor_user_id = mafia.current_game_user_id());

drop policy if exists mafia_match_chats_demon_circle_read on mafia.match_chats;
create policy mafia_match_chats_demon_circle_read on mafia.match_chats
  for select
  to authenticated
  using (
    channel = 'demon_circle'
    and mafia.is_demon_circle_member(match_id)
  );

drop policy if exists mafia_match_events_visible_read on mafia.match_events;
create policy mafia_match_events_visible_read on mafia.match_events
  for select
  to authenticated
  using (
    (
      visibility = 'public'
      and mafia.is_match_participant(match_id)
    )
    or (
      visibility = 'private'
      and recipient_user_id = mafia.current_game_user_id()
    )
  );

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
    when mp.role in ('demon', 'helper') and mafia.is_demon_circle_member(mp.match_id) then mp.role
    else null
  end as role,
  case
    when mp.user_id = mafia.current_game_user_id() then mp.faction
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended' then mp.faction
    when mp.role in ('demon', 'helper') and mafia.is_demon_circle_member(mp.match_id) then mp.faction
    else null
  end as faction
from mafia.match_players mp;

grant usage on schema mafia to authenticated;
grant select on
  mafia.users,
  mafia.identities,
  mafia.matches,
  mafia.match_players,
  mafia.match_phases,
  mafia.match_actions,
  mafia.match_chats,
  mafia.match_events,
  mafia.match_players_visible
to authenticated;

-- No client write policies are defined in this migration. The game server must
-- write with service_role so all state changes pass through authoritative API
-- validation.
