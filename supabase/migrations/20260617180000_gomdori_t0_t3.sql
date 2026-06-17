-- T0/T3 신규 action_type 등록 (2026-06-17):
--   mizlet_wine(미즐렛 고급 와인), helen_freebird(헬렌 자유로운 새),
--   habreterus_deduce(하브레터스 삶이 있는 곳으로 상호추리), luru_score(루루 악보 교체).
-- NIGHT_ACTIONS_BY_ROLE 은 roles.ts 파생이라 코드 변경 불필요 — CHECK 제약만 갱신.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','mizlet_wine','helen_revive','helen_sleep','helen_freebird',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse',
    'phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','besto_hidden','besto_shift','daeakma_brand','daeakma_dominion',
    'luna_moonlight','luna_corrupt','logen_nullify','gain_hypocrisy','ellen_persecute',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
