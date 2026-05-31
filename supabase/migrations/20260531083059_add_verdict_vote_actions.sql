alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill',
    'doctor_heal',
    'police_investigate',
    'vote',
    'verdict_approve',
    'verdict_reject'
  ));

create unique index if not exists mafia_match_actions_one_verdict_ballot_idx
  on mafia.match_actions (phase_id, actor_user_id)
  where action_type in ('verdict_approve', 'verdict_reject');
