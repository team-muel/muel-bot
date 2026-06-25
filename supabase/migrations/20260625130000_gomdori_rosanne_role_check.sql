-- 곰도리 로잔느 배정 가능화 (2026-06-25): match_players_role_check 에 'rosanne' 추가.
-- 직전 role CHECK 전체 재정의본(20260610150000_gomdori_v2_helpers)의 전 직업 + 'rosanne' 합집합으로
-- 단일 재정의한다. 'besto' 는 과거 데이터/히스토리 행 안전을 위해 허용 목록에 유지(무해 — match-start
-- 가 더 이상 besto 를 스폰하지 않으므로 신규 배정엔 쓰이지 않는다).
-- 로잔느는 독립 중립 솔로(파스아와 같은 중립 풀) — match-start 가 파스아와 상호배타로 스폰한다.

alter table mafia.match_players
  drop constraint if exists match_players_role_check;

alter table mafia.match_players
  add constraint match_players_role_check
  check (role in (
    -- 레거시(미배정)
    'citizen', 'doctor', 'police', 'helper',
    -- 악마 풀 (besto 는 히스토리 보존용 유지)
    'demon', 'phantom', 'malen', 'besto',
    -- 조력자 풀
    'gain', 'luna', 'logen', 'ellen',
    -- 천사 풀
    'romaz', 'rainer', 'dordan', 'habreterus', 'mizlet', 'helen', 'uno', 'arthur', 'seika', 'luru',
    -- 중립 (파스아 + 로잔느 독립 솔로)
    'pasua', 'converted', 'corrupted', 'rosanne'
  ));
