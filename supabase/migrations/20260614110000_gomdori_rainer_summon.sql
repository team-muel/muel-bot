-- Gomdori v2 — 라이너 백호 소환(self, 1회) action_type.
--   rainer_summon : 백호 소환(self GrantCount — countBonus +1 / deadCountBonus +1).
--   v2 에서 배정 시 자동 주입을 폐지하고 능동 소환으로 전환(자석은 v1 과 동일).

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill',
    'doctor_heal',
    'police_investigate',
    'romaz_suspect',
    'rainer_summon',
    'pasua_convert',
    'pasua_faith',
    'mizlet_revive',
    'helen_revive',
    'seika_supernova',
    'phantom_seal',
    'phantom_nightmare',
    'phantom_eclipse',
    'malen_release',
    'malen_possess',
    'besto_hidden',
    'besto_shift',
    'daeakma_brand',
    'luna_corrupt',
    'logen_nullify',
    'ellen_persecute',
    'uno_struggle',
    'arthur_emberblade',
    'luru_charm',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
