-- 곰도리 원문 충실화 (2026-06-25): 로잔느 〈능력〉 외현기억 추가.
--   rosanne_manifest : 외현기억(탈락자 1인 지정 — 매 아침 부활→그 날 끝 처형, 투표 재처형 시 효과
--                      상실 + 재지정 불가, futureCharge 1 소비 = Manifest). bounded(manifestCycles<2)
--                      morning hook 으로 수렴 보장.
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260625140000)의
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
    'rosanne_hatred','rosanne_resentment','rosanne_rapport','rosanne_manifest',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score','luru_mute',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
