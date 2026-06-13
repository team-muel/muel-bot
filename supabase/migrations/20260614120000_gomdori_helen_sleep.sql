-- Gomdori v2 — 헬렌 황금빛 수면(생존자 수면) action_type.
--   helen_sleep : 황금빛 수면(생존자 대상 Sleep — 보호+행동봉인+부정효과 무효).
--   helen_revive(탈락자 부활)와 별개 능력. Sleep 은 이펙트(엔진), action_type 만 추가.

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
    'helen_sleep',
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
