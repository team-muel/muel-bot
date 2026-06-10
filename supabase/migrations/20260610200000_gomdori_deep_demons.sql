-- Gomdori M1 — 깊은 악마 마감(베스토·대악마·팬텀 일식) action_type.
--   besto_hidden   : 히든 포지션(처치, Kill). 처치 능력이 demon_kill 이 아닌 고유 id.
--   besto_shift    : 변신(self 토글 — 솔/하베스토, 조사 시 천사로 회피 Disguise).
--   daeakma_brand  : 메피스토 낙인(대상 직업 삭제 → 임의 천사 직업으로 비밀 재배정 Rebrand).
--   phantom_eclipse: 일식(self — 다음 아침을 밤으로 바꾸고 팬텀 소멸 Eclipse).

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
