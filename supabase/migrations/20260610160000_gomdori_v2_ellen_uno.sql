-- Gomdori v2 — 엘런(박해)·우노(투쟁) action_type.
--   ellen_persecute : 대상의 받는-투표가치 누진(ModifyReceivedVote) — 표적을 처형대로.
--   uno_struggle    : 대상 소속 카운트 +1(GrantCount 이펙트).

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill',
    'doctor_heal',
    'police_investigate',
    'romaz_suspect',
    'pasua_convert',
    'mizlet_revive',
    'helen_revive',
    'seika_supernova',
    'phantom_seal',
    'luna_corrupt',
    'logen_nullify',
    'ellen_persecute',
    'uno_struggle',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
