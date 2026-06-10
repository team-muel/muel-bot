-- Gomdori M1-1 팬텀 악몽 — action_type phantom_nightmare.
--   팬텀의 처치 능력을 demon_kill → 악몽(지연 탈락, 아침 해소)으로. 봉인(phantom_seal)은 유지.
--   악몽 사망은 eliminated_cause='night_kill' 재사용(이벤트 nightmare_death 로 구분).

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
