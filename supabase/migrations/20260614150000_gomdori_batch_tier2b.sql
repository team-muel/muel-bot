-- Gomdori v2 배치B — 아서 단죄 + 미즐렛 디저트 버프 action_type.
--   arthur_judge  : 단죄(폭열→소멸, Annihilate · 2회).
--   mizlet_dessert: 디저트 선물(생존자 보호+태그, Protect+AddTag).
--   말렌 SoulCounter 는 death-hook(이펙트 레벨, action_type 불변).

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
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
