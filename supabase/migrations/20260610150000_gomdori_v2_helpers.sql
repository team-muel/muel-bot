-- Gomdori v2 조력자 고유 — 루나(변환)·로건(무력화).
--   role 'corrupted' : 루나에게 타락한 천사(악마팀 카운트, 능력 없음).
--   action_type luna_corrupt : 천사 → 악마팀 변환(Corrupt 이펙트).
--   action_type logen_nullify : 그 밤 대상 능력 무력화(Silence 재사용).

alter table mafia.match_players
  drop constraint if exists match_players_role_check;

alter table mafia.match_players
  add constraint match_players_role_check
  check (role in (
    'citizen', 'doctor', 'police', 'helper',
    'demon', 'phantom', 'malen', 'besto',
    'gain', 'luna', 'logen', 'ellen',
    'romaz', 'rainer', 'dordan', 'habreterus', 'mizlet', 'helen', 'uno', 'arthur', 'seika', 'luru',
    'pasua', 'converted', 'corrupted'
  ));

alter table mafia.match_actions
  drop constraint if exists match_actions_action_type_check;

alter table mafia.match_actions
  add constraint match_actions_action_type_check
  check (action_type in (
    'demon_kill',
    'doctor_heal',
    'police_investigate',
    'romaz_suspect',
    'pasua_convert',
    'mizlet_revive',
    'helen_revive',
    'seika_supernova',
    'phantom_seal',
    'luna_corrupt',
    'logen_nullify',
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));
