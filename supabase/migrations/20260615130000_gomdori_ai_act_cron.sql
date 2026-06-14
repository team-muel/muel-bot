-- AI 용병 행동 루프 (2026-06-15, ADR-005 Increment 2)
--
-- 기존 5초 루프(run_phase_advance_loop)가 매 틱 phase-advance 와 함께 match-ai-act 도
-- 호출하도록 확장한다. match-ai-act 가 활성 매치의 AI 플레이어 행동을 채운다(사람과
-- 동일한 검증 코어). verify_jwt=false(supabase/config.toml) 이므로 베어러 토큰 불필요.
-- 스케줄(cron.schedule 'mafia-phase-advance')은 그대로 — 함수만 교체한다.

create or replace function public.run_phase_advance_loop()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
DECLARE
  i integer;
  target_url text;
BEGIN
  target_url := coalesce(
    nullif(current_setting('mafia.supabase_url', true), ''),
    'https://pqzmehtuwnxyspfhyucd.supabase.co'
  );

  for i in 1..12 loop
    perform net.http_post(
      url:= target_url || '/functions/v1/phase-advance',
      headers:='{"Content-Type": "application/json"}'::jsonb
    );

    -- AI 용병 행동 채우기(있으면). phase-advance 가 페이즈를 끝내기 전에 AI 가 행동한다.
    perform net.http_post(
      url:= target_url || '/functions/v1/match-ai-act',
      headers:='{"Content-Type": "application/json"}'::jsonb,
      body:='{}'::jsonb
    );

    if i < 12 then
      perform pg_sleep(5);
    end if;
  end loop;
end;
$$;

revoke all on function public.run_phase_advance_loop() from public;
revoke all on function public.run_phase_advance_loop() from anon;
revoke all on function public.run_phase_advance_loop() from authenticated;
