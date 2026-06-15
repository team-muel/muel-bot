-- Gomdori v2 — 세이카 자신만 아플 거야 action_type.
--   seika_absorb : 전원 부여 효과를 흡수(전원 Cleanse, NONE 대상, 1회). 악마팀 효과 3개+
--   소멸·이틀 후 악마팀 공개의 downside 는 후속(서브시스템). 핵심 시그니처(전원 정화)만 라이브.

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
