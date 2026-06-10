-- Gomdori W6 v1 중립 — 파스아(사이비 교주) 런타임 DB 계약.
--
-- 파스아는 천사·악마 어디에도 속하지 않는 중립 직업. 포교(전향)로 천사/가인을
-- 자기 진영(converted)으로 흡수하고, 누적 3명 전향 시 단독 즉시 승리.
-- 등장은 로비 게임 설정(matches.settings.includeNeutral) + 8인 이상에서만.
--
-- 변경:
--   1) match_players.faction 에 'neutral' 허용 (파스아 본인).
--   2) match_players.role 에 'pasua' + 'converted' 추가.
--   3) match_actions.action_type 에 'pasua_convert'(포교) 추가.
--   4) matches.winner 에 'neutral' 추가 (파스아 단독 승리).
--   5) matches.settings jsonb 추가 — 로비 게임 설정(중립 포함 등). 기본 '{}'.

alter table mafia.match_players
  drop constraint if exists match_players_faction_check;

alter table mafia.match_players
  add constraint match_players_faction_check
  check (faction in ('angel', 'demon', 'neutral'));

alter table mafia.match_players
  drop constraint if exists match_players_role_check;

alter table mafia.match_players
  add constraint match_players_role_check
  check (role in (
    'citizen',
    'doctor',
    'police',
    'demon',
    'helper',
    'rainer',
    'romaz',
    'gain',
    'pasua',
    'converted'
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
    'vote',
    'suspect',
    'verdict_approve',
    'verdict_reject'
  ));

alter table mafia.matches
  drop constraint if exists matches_winner_check;

alter table mafia.matches
  add constraint matches_winner_check
  check (winner in ('angels', 'demons', 'neutral'));

alter table mafia.matches
  add column if not exists settings jsonb not null default '{}'::jsonb;
