-- 페이즈 전환 데드존 추가 축소: mafia-phase-advance 크론 15초 → 10초.
-- 투표/의심 등 선택 후 전환 대기가 길다는 피드백 반영. phase-advance 는 멱등이라 안전.
-- jobname 으로 조회해 환경 무관하게 적용(이미 라이브 alter_job 적용, 기록용 마이그레이션).
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'mafia-phase-advance';
  if v_jobid is not null then
    perform cron.alter_job(v_jobid, schedule := '10 seconds');
  end if;
end $$;
