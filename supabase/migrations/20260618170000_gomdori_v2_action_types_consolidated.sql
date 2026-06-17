-- 곰도리 v2 배치(가인/루나/엘런/하브레터스/루루/라이너) action_type 통합 (2026-06-18).
-- 6개 PR(#179~#187)이 각자 master 기준으로 match_actions_action_type_check 전체를 재정의했기에
-- 파일명 순서대로 순차 적용하면 마지막(rainer)만 남아 gain_raid/luna_dawn/luna_moonrise/
-- ellen_shatter/demon_deduce/luru_mute 가 누락된다. 또한 직전 20260617190000_gomdori_malen_elusive
-- 가 라이브에 미적용 상태(malen_elusive 누락)였다. 전 타입 합집합으로 단일 재정의해 정합화.

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill','doctor_heal','police_investigate','romaz_suspect','rainer_summon','rainer_resolve','rainer_resistance',
    'pasua_convert','pasua_faith','mizlet_revive','mizlet_dessert','mizlet_wine','helen_revive','helen_sleep','helen_freebird',
    'seika_supernova','seika_absorb','phantom_seal','phantom_nightmare','phantom_eclipse','phantom_reap','phantom_silentnight',
    'malen_release','malen_possess','malen_elusive','besto_hidden','besto_shift','besto_frameup','daeakma_brand','daeakma_dominion','demon_deduce',
    'luna_moonlight','luna_corrupt','luna_dawn','luna_moonrise','logen_nullify','gain_hypocrisy','gain_raid','ellen_persecute','ellen_shatter',
    'uno_struggle','uno_valor','arthur_emberblade','arthur_judge','luru_charm','luru_sonata','luru_score','luru_mute',
    'dordan_infiltrate','habreterus_deduce',
    'vote','suspect','verdict_approve','verdict_reject',
    'time_cut','time_extend','ai_day_chat'
  ));
