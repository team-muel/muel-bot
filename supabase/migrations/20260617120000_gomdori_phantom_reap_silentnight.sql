-- 팬텀 신규 액션 action_type: phantom_reap(영면 발동 — 누적 영면 일괄 처치),
--   phantom_silentnight(침묵의 밤 — 밤 연장 + 생존 천사팀 카운트 +1).
-- match-action 의 NIGHT_ACTIONS_BY_ROLE/requiresNoTarget 은 roles.ts 에서 파생되므로 코드 변경 불필요.

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
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
