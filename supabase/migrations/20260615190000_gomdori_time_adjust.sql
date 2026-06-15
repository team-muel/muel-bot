-- 토론(day) 시간 조절 action_type 추가: time_cut(-20초)/time_extend(+10초).
--   유저당 현재 day 페이즈에서 1회(총량). match-adjust-time 엣지가 기록·검증한다.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','helen_revive','helen_sleep',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse',
    'malen_release','malen_possess','besto_hidden','besto_shift','daeakma_brand','daeakma_dominion',
    'luna_moonlight','luna_corrupt','logen_nullify','gain_hypocrisy','ellen_persecute',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend'
  ));
