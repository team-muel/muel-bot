-- 곰도리 원문 충실화 (2026-06-26): 라이너 거친 포효 — 플레이어 지목 2명 백호 발톱(clawed).
--   rainer_roar : '강한 의지'(willCount) 2회 누적 시 발동 — 2명 직접 지목해 clawed 표식. 공격당한
--                 대상은 다음 아침 행사 투표가치 ≥3 이면 소멸(phase-advance morning hook). 과거
--                 willCount≥2 즉시 자동 발동은 미제출 시 폴백으로 유지(double-consume 방지: 제출 시 자동 생략).
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260625180000)의
-- 전 타입을 그대로 유지하고 rainer_roar 만 추가한 합집합으로 단일 재정의한다(기존 값 제거 금지 —
-- mizlet_dessert/besto_* 포함 전부 보존).

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','romaz_conviction','rainer_summon','rainer_resolve','rainer_resistance','rainer_roar',
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
