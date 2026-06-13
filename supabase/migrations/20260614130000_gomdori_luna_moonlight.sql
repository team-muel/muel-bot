-- Gomdori v2 — 루나 고요한 적막(달의 힘 충전 + 달빛) action_type.
--   luna_moonlight : 고요한 적막(NONE — 자기 달 게이지 +1, 투표/의심 대상에 달빛 태그).
--   루나 공포(luna_corrupt)는 달의 힘 2 이상에서만 발동(requiresCounter, 엔진).

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
    'luna_moonlight',
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
