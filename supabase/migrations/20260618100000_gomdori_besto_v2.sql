-- 베스토 v2: 누명씌우기(besto_frameup) 신규 action_type 등록 (2026-06-18).
-- besto_hidden / besto_shift 는 기존 등록 유지. 강화 스택·짝숫날 게이트는 코드만(스키마 변경 없음).

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','mizlet_wine','helen_revive','helen_sleep','helen_freebird',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse',
    'phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','malen_elusive','besto_hidden','besto_shift','besto_frameup','daeakma_brand','daeakma_dominion',
    'luna_moonlight','luna_corrupt','logen_nullify','gain_hypocrisy','ellen_persecute',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
