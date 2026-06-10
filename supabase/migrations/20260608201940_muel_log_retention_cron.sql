-- 로그 보존 정책: 텔레메트리 72h, 대화 원문 168h. 메모리는 카드(weave)에 영속되므로 원문/로그는 휘발.
-- 되돌리려면: select cron.unschedule('muel_log_retention');
select cron.schedule(
  'muel_log_retention',
  '13 18 * * *',  -- 매일 03:13 KST (18:13 UTC)
  $$
    delete from public.muel_ai_events where created_at < now() - interval '72 hours';
    delete from public.muel_feedback_signals where created_at < now() - interval '72 hours' and status in ('triaged','resolved','ignored');
    delete from public.muel_messages_v2 where created_at < now() - interval '168 hours';
  $$
);;
