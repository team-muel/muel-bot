-- Gomdori v2 — 가인 약간의 위선 action_type.
--   gain_hypocrisy : 약간의 위선(대상 진영 통지 = 악마팀 정찰, SINGLE_ALIVE). 효과 연기(다음 밤)
--   는 지속 카운터 필요 — 후속. 핵심 시그니처(조사)만 라이브.

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
    'mizlet_dessert',
    'helen_revive',
    'helen_sleep',
    'seika_supernova',
    'seika_absorb',
    'phantom_seal',
    'phantom_nightmare',
    'phantom_eclipse',
    'malen_release',
    'malen_possess',
    'besto_hidden',
    'besto_shift',
    'daeakma_brand',
    'daeakma_dominion',
    'luna_moonlight',
    'luna_corrupt',
    'logen_nullify',
    'gain_hypocrisy',
    'ellen_persecute',
    'uno_struggle',
    'uno_valor',
    'arthur_emberblade',
    'arthur_judge',
    'luru_charm',
    'luru_sonata',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
