-- Gomdori v2 고유능력 wave 1 — 새 밤 행동 action_type.
--
--   mizlet_revive / helen_revive : 부활(탈락자 대상, SINGLE_DEAD) — 미즐렛 디저트·헬렌 황금빛 수면.
--   seika_supernova              : 봉인(그 밤 대상 능력 발동 불가) — 세이카 초신성.
--   phantom_seal                 : 봉인 — 팬텀 어둠이 내린 도시(처치와 병행).
-- 부활은 기존 Heal 이펙트(dead→alive) 재사용, 봉인은 신규 Silence 이펙트(counters.silencedNights).

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
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
