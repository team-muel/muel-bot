-- Gomdori M1 — 말렌 혼령 방출(처치)·빙의 action_type.
--   malen_release : 혼령 방출(처치, Kill). 팬텀처럼 처치 능력이 demon_kill 이 아닌 고유 id.
--   malen_possess : 빙의(그 밤 행동 봉인 Possess + 그 라운드 악마팀 카운트 전환).

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
    'phantom_nightmare',
    'malen_release',
    'malen_possess',
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
