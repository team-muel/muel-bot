-- Research DM redelivery: keep the full report and allow a token-free
-- 'pending_dm' delivery state so blocked DMs can be re-sent on the user's
-- next interaction (no reliance on the 15-min Discord interaction token).

alter table public.muel_research_jobs add column if not exists report_full text;

alter table public.muel_research_jobs drop constraint if exists muel_research_jobs_delivery_channel_check;
alter table public.muel_research_jobs add constraint muel_research_jobs_delivery_channel_check
  check (delivery_channel = any (array['dm','fallback_ephemeral','fallback_thread','none','pending_dm']));

create index if not exists idx_muel_research_jobs_pending_dm
  on public.muel_research_jobs (requester_user_id)
  where delivery_channel = 'pending_dm' and delivered_at is null;
