-- Gomdori: bind a match to the Discord Activity instance (instance_id) so all
-- participants who launch the Activity in the same voice channel share one match.
-- instance is the Discord-native key; context_id (channel) stays as fallback/context.

alter table mafia.matches add column if not exists instance_id text;

create index if not exists matches_instance_id_active_idx
  on mafia.matches (instance_id)
  where status in ('lobby','role_assign','night','night_resolve','day','vote','verdict');
