-- 곰도리 원문 충실화 (2026-06-25): 로마즈 〈능력2〉 신념 추가 + 〈능력〉 용의자 색출 원문 확장.
--   romaz_conviction : 신념(무시불가·1회) — 용의자(romazSuspect)였던 대상 1명 탈락(Kill). 탈락자가
--                      천사팀이면 로마즈 convictionBlocked=1(이후 조사장-3 구금 봉인 = 원문 능력2 봉인 절).
--   romaz_suspect 는 기존 타입(유지) — 조사장(clueWarrant) 획득 + 용의자 표식 + 조사장-3 무조건 구금
--                  (Silence)·조사 통지(match-action-core)를 엔진/코어에서 추가. action_type 변경 없음.
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260625160000)의
-- 전 타입 + 신규 1종(romaz_conviction) 합집합으로 단일 재정의한다.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','romaz_conviction','rainer_summon','rainer_resolve','rainer_resistance',
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
