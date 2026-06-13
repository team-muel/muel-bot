-- Gomdori v2 배치 — 우노 용맹함 + 대악마 압도적 존재감 action_type.
--   uno_valor       : 용맹함(SELF, 1회 — 자기 Cleanse + 명예 GrantCount).
--   daeakma_dominion: 압도적 존재감(ALL, 1회 — 전원 Silence).
--   로건 Nullify·팬텀 영면은 이펙트 레벨(action_type 불변).

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
    'daeakma_dominion',
    'luna_moonlight',
    'luna_corrupt',
    'logen_nullify',
    'ellen_persecute',
    'uno_struggle',
    'uno_valor',
    'arthur_emberblade',
    'luru_charm',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
