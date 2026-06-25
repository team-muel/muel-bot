-- 곰도리 원문 충실화 (2026-06-25): 로잔느 〈능력2〉 건너뛰기 추가.
--   rosanne_skip : 건너뛰기(self·priority 0·1회 — 이 밤 발동한 다른 모든 효과 취소 = SkipNight).
--                  원문 "다음 밤으로 이월" 진짜 replay 와 "잔여 채 승리 시 조력자 패배" win 조항은 후속.
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260625150000)의
-- 전 타입 + 신규 1종 합집합으로 단일 재정의한다.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon','rainer_resolve','rainer_resistance',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','mizlet_wine','helen_revive','helen_sleep','helen_freebird',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse','phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','malen_elusive','besto_hidden','besto_shift','besto_frameup','daeakma_brand','daeakma_dominion','demon_deduce',
    'luna_moonlight','luna_corrupt','luna_dawn','luna_moonrise','logen_nullify','logen_allwell','gain_hypocrisy','gain_raid','ellen_persecute','ellen_shatter','ellen_chaos',
    'rosanne_hatred','rosanne_resentment','rosanne_rapport','rosanne_manifest','rosanne_skip',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score','luru_mute',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
