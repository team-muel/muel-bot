-- 1분마다 실행되는 pg_cron 안에서 5초 간격으로 phase-advance를 트리거하는 루프 함수
CREATE OR REPLACE FUNCTION public.run_phase_advance_loop()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  i integer;
  target_url text;
BEGIN
  -- mafia.supabase_url 설정이 있으면 사용하고, 없으면 기존 하드코딩된 프로젝트 URL로 폴백
  target_url := coalesce(
    nullif(current_setting('mafia.supabase_url', true), ''),
    'https://pqzmehtuwnxyspfhyucd.supabase.co'
  );

  -- 1분에 12번 실행 (5초 간격)
  FOR i IN 1..12 LOOP
    -- URL은 현재 프로젝트의 Edge Function 주소 (권한 체크가 없으므로 헤더 생략 가능)
    PERFORM net.http_post(
      url:= target_url || '/functions/v1/phase-advance',
      headers:='{"Content-Type": "application/json"}'::jsonb
    );
    
    -- 마지막 루프가 아니면 5초 대기
    IF i < 12 THEN
      PERFORM pg_sleep(5);
    END IF;
  END LOOP;
END;
$$;

-- 기존 크론 잡이 있다면 제거
SELECT cron.unschedule('mafia-phase-advance');

-- 1분마다 위의 루프 함수를 실행하도록 스케줄링
SELECT cron.schedule('mafia-phase-advance', '* * * * *', 'SELECT public.run_phase_advance_loop()');
