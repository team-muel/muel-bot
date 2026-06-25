-- 곰도리 원문 충실화 배치 (2026-06-25): besto→로잔느 교체 + 로건/엘런 〈능력2〉 추가.
--   rosanne_hatred      : 로잔느 증오(특수 패시브 — 지목 대상 투표가치 -1, 0 도달 즉시 처형 = VoteCrush).
--   rosanne_resentment  : 로잔느 만들어가는 미래(르상티망 약식 — 원한 표식 + 아침 +1, futureCharge 소비).
--   logen_allwell       : 로건 전부 괜찮을 거야(사용/1회 — 펜던트 적용자 무적 / 비적용자 파멸 1중첩, 2중첩 소멸).
--   ellen_chaos         : 엘런 혼탁해진 정의(지정/2회 — 대상 다음 밤 능력 봉인 + 박해 표적이면 탈락).
-- action_type CHECK 은 매 마이그레이션이 전체 재정의(union)하므로, 직전 통합본(20260618170000)의
-- 전 타입 + 신규 3종 합집합으로 단일 재정의한다. (besto_* 는 과거 데이터/히스토리 보존 위해 union 에 유지.)

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
    'rosanne_hatred','rosanne_resentment',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score','luru_mute',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
