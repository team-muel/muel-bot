-- Gomdori 페이즈 전환 데드존 축소: mafia-phase-advance 크론을 매 1분('* * * * *')에서
-- 15초 주기로 변경한다. pg_cron 은 분 단위 cron 표현식만 쓰면 만료 후 최대 ~60초 동안
-- 전환이 지연돼, 특히 role_assign(30초) 같은 짧은 페이즈에서 "곧 전환"이 멈춘 듯 보였다.
-- '15 seconds' 인터벌 스케줄(pg_cron 1.5+)로 데드존을 ~15초로 줄인다. phase-advance 는
-- 멱등(만료 페이즈 claim)이라 더 잦은 폴링이 안전하다. jobname 으로 조회해 환경 무관하게 적용.
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'mafia-phase-advance';
  if v_jobid is not null then
    perform cron.alter_job(v_jobid, schedule := '15 seconds');
  end if;
end $$;
