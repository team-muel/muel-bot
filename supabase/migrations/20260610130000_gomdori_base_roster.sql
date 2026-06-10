-- Gomdori 기본 로스터 — match_players.role CHECK 에 명명 직업 전체 추가.
--
-- "시민(무직)" 폐지: match-start 가 진영 풀에서 서로 다른 명명 직업을 뽑아 전원 배정.
--   악마 풀(처치): demon(대악마)·phantom·malen·besto
--   조력자 풀: gain·luna·logen·ellen
--   천사 풀: romaz·rainer·dordan·habreterus·mizlet·helen·uno·arthur·seika·luru
--   중립: pasua / 전향 상태: converted
-- v1 은 시그니처를 기존 action_type(demon_kill/doctor_heal/police_investigate/romaz_suspect/
-- pasua_convert)에 매핑하므로 action_type·faction·winner CHECK 는 변경 없음(직업명만 확장).
-- citizen/doctor/police/helper 는 레거시로 CHECK 에 남겨두되 배정엔 쓰이지 않는다.

alter table mafia.match_players
  drop constraint if exists match_players_role_check;

alter table mafia.match_players
  add constraint match_players_role_check
  check (role in (
    -- 레거시(미배정)
    'citizen', 'doctor', 'police', 'helper',
    -- 악마 풀
    'demon', 'phantom', 'malen', 'besto',
    -- 조력자 풀
    'gain', 'luna', 'logen', 'ellen',
    -- 천사 풀
    'romaz', 'rainer', 'dordan', 'habreterus', 'mizlet', 'helen', 'uno', 'arthur', 'seika', 'luru',
    -- 중립
    'pasua', 'converted'
  ));
