-- 1. 테이블 라벨 컬럼 추가 (채널 내 여러 매치 구분용)
ALTER TABLE mafia.matches
  ADD COLUMN IF NOT EXISTS table_label text NOT NULL DEFAULT '';

-- 2. 라벨 자동생성 함수: 채널 내 open 매치 중 가장 큰 번호 +1
CREATE OR REPLACE FUNCTION mafia.next_table_number(
  p_context_type text,
  p_context_id text
) RETURNS int AS $$
  SELECT coalesce(
    max(
      CASE
        WHEN table_label ~ '\d+$' THEN (regexp_match(table_label, '\d+$'))[1]::int
        ELSE 0
      END
    ), 0
  ) + 1
  FROM mafia.matches
  WHERE context_type = p_context_type
    AND context_id = p_context_id
    AND status NOT IN ('ended', 'aborted');
$$ LANGUAGE sql STABLE;

-- 3. match_players 에 heartbeat 인덱스 (sweep 쿼리 최적화)
CREATE INDEX IF NOT EXISTS mafia_match_players_last_seen_idx
  ON mafia.match_players (last_seen_at)
  WHERE last_seen_at IS NOT NULL;

-- 4. matches 에 GC 소멸용 인덱스 (빈 lobby 조회)
CREATE INDEX IF NOT EXISTS mafia_matches_lobby_context_idx
  ON mafia.matches (context_type, context_id)
  WHERE status = 'lobby';

-- 5. next_table_number 실행 권한
GRANT EXECUTE ON FUNCTION mafia.next_table_number(text, text) TO service_role;
