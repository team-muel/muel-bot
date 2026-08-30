-- Cover the match_id foreign key used by lease cleanup and cascading deletes.
create index if not exists match_ai_act_leases_match_id_idx
on mafia.match_ai_act_leases (match_id);
