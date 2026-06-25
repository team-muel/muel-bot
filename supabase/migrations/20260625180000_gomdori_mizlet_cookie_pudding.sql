-- 곰도리 원문 충실화 (2026-06-25): 미즐렛 디저트 선물 쿠키/푸딩 분리.
--   mizlet_cookie  : 쿠키 — 그 밤 보호 + 디저트 태그 + 'cookie' 표식(보유 중 탈락해도 그 밤 능력 발동).
--   mizlet_pudding : 푸딩 — 그 밤 보호 + 디저트 태그 + 'pudding' 표식(단일 대상 능력 '무시 불가' = 봉인/
--                    지목 게이트 1회 우회). '탈락 시점 밤 조정' 절은 사망 기록 타이밍과 얽혀 후속(defer).
--   기존 mizlet_dessert 는 두 변형(쿠키/푸딩)으로 대체되나, 과거 match_actions 행 호환 위해 CHECK 엔 유지(엔진은 더 이상 발급 X).
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260625170000)의
-- 전 타입에서 mizlet_dessert 를 빼고 mizlet_cookie·mizlet_pudding 을 더한 합집합으로 단일 재정의한다.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','romaz_conviction','rainer_summon','rainer_resolve','rainer_resistance',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','mizlet_cookie','mizlet_pudding','mizlet_wine','helen_revive','helen_sleep','helen_freebird',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse','phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','malen_elusive','besto_hidden','besto_shift','besto_frameup','daeakma_brand','daeakma_dominion','demon_deduce',
    'luna_moonlight','luna_corrupt','luna_dawn','luna_moonrise','logen_nullify','logen_allwell','gain_hypocrisy','gain_raid','ellen_persecute','ellen_shatter','ellen_chaos',
    'rosanne_hatred','rosanne_resentment','rosanne_rapport','rosanne_manifest','rosanne_skip',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score','luru_mute',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
