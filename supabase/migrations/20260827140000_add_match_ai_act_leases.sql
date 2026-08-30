-- Ensure overlapping cron deliveries never process the same Gomdori phase twice.
-- The short lease is renewed before each AI actor; crashed invocations recover
-- automatically after the lease expires. A new phase has a distinct lease, so
-- stale work can never block AI actions in the next phase.
create table if not exists mafia.match_ai_act_leases (
  phase_id uuid primary key references mafia.match_phases(id) on delete cascade,
  match_id uuid not null references mafia.matches(id) on delete cascade,
  holder uuid not null,
  expires_at timestamptz not null
);

alter table mafia.match_ai_act_leases enable row level security;
revoke all on table mafia.match_ai_act_leases from public;
revoke all on table mafia.match_ai_act_leases from anon;
revoke all on table mafia.match_ai_act_leases from authenticated;

create or replace function mafia.claim_match_ai_act_lease(
  p_match_id uuid,
  p_phase_id uuid,
  p_holder uuid,
  p_ttl_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = mafia, pg_temp
as $$
declare
  affected integer;
begin
  insert into mafia.match_ai_act_leases(phase_id, match_id, holder, expires_at)
  values (
    p_phase_id,
    p_match_id,
    p_holder,
    clock_timestamp() + make_interval(secs => greatest(10, least(p_ttl_seconds, 300)))
  )
  on conflict (phase_id) do update
    set holder = excluded.holder,
        match_id = excluded.match_id,
        expires_at = excluded.expires_at
    where mafia.match_ai_act_leases.expires_at <= clock_timestamp();

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function mafia.renew_match_ai_act_lease(
  p_match_id uuid,
  p_phase_id uuid,
  p_holder uuid,
  p_ttl_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = mafia, pg_temp
as $$
declare
  affected integer;
begin
  update mafia.match_ai_act_leases
     set expires_at = clock_timestamp()
       + make_interval(secs => greatest(10, least(p_ttl_seconds, 300)))
   where phase_id = p_phase_id
     and match_id = p_match_id
     and holder = p_holder
     and expires_at > clock_timestamp();

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function mafia.release_match_ai_act_lease(
  p_match_id uuid,
  p_phase_id uuid,
  p_holder uuid
)
returns void
language sql
security definer
set search_path = mafia, pg_temp
as $$
  delete from mafia.match_ai_act_leases
   where phase_id = p_phase_id
     and match_id = p_match_id
     and holder = p_holder;
$$;

revoke all on function mafia.claim_match_ai_act_lease(uuid, uuid, uuid, integer) from public;
revoke all on function mafia.claim_match_ai_act_lease(uuid, uuid, uuid, integer) from anon;
revoke all on function mafia.claim_match_ai_act_lease(uuid, uuid, uuid, integer) from authenticated;
grant execute on function mafia.claim_match_ai_act_lease(uuid, uuid, uuid, integer) to service_role;

revoke all on function mafia.renew_match_ai_act_lease(uuid, uuid, uuid, integer) from public;
revoke all on function mafia.renew_match_ai_act_lease(uuid, uuid, uuid, integer) from anon;
revoke all on function mafia.renew_match_ai_act_lease(uuid, uuid, uuid, integer) from authenticated;
grant execute on function mafia.renew_match_ai_act_lease(uuid, uuid, uuid, integer) to service_role;

revoke all on function mafia.release_match_ai_act_lease(uuid, uuid, uuid) from public;
revoke all on function mafia.release_match_ai_act_lease(uuid, uuid, uuid) from anon;
revoke all on function mafia.release_match_ai_act_lease(uuid, uuid, uuid) from authenticated;
grant execute on function mafia.release_match_ai_act_lease(uuid, uuid, uuid) to service_role;
