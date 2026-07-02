-- Gomdori: 상호추리 전용 페이즈 night_deduce (canon 하브레터스 "매 밤마다 서로 정체 추리").
--
-- 하브레터스와 악마 처치자가 모두 생존한 매치에서만 phase-advance 가
-- night_suspect → night_deduce → night 로 끼워 넣는다. 하브가 없는 게임은
-- 전이 자체가 발생하지 않아 기존 흐름 무영향. action_type 은 기존
-- habreterus_deduce / demon_deduce 재사용이라 변경 없음.

alter table mafia.matches
  drop constraint if exists matches_status_check;

alter table mafia.matches
  add constraint matches_status_check
  check (status in (
    'lobby',
    'role_assign',
    'night',
    'night_suspect',
    'night_deduce',
    'night_resolve',
    'day',
    'vote',
    'verdict',
    'ended',
    'aborted'
  ));

alter table mafia.match_phases
  drop constraint if exists match_phases_phase_type_check;

alter table mafia.match_phases
  add constraint match_phases_phase_type_check
  check (phase_type in (
    'role_assign',
    'night',
    'night_suspect',
    'night_deduce',
    'night_resolve',
    'day',
    'vote',
    'verdict',
    'end'
  ));
