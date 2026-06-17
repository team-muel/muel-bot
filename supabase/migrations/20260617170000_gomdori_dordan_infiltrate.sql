-- 도르단 잠입 수사(dordan_infiltrate) 신규 action_type 등록 (2026-06-17).
-- 관찰 대상이 그 밤 탈락하면 불심검문 발동(도르단 그 밤 부정효과 무시). NIGHT_ACTIONS_BY_ROLE 은
-- roles.ts 에서 파생되므로 코드 변경 불필요 — CHECK 제약만 갱신한다.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','helen_revive','helen_sleep',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse',
    'phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','besto_hidden','besto_shift','daeakma_brand','daeakma_dominion',
    'luna_moonlight','luna_corrupt','logen_nullify','gain_hypocrisy','ellen_persecute',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata',
    'dordan_infiltrate',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
