-- Gomdori v2 배치C — 루루 소나타 action_type.
--   luru_sonata : 아름다운 영혼을 위한 소나타(NONE, 매료 3 누적 시 — 전원 Cleanse + 자기 Protect).
--   도르단 단서(death-hook 카운터 + 정밀조사)는 이펙트/match-action 레벨(action_type 불변).

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
