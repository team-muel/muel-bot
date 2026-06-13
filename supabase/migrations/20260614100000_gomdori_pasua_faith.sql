-- Gomdori v2 — 파스아 신앙(처치, 악마 면역) action_type.
--   pasua_faith : 신앙(대상 탈락, Kill + immuneFactions=['demon']). 포교와 별개 능력.
--   연속 포교 제한은 엔진 counters.convertCooldown 로 처리(스키마 변경 없음).

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
