-- Idempotent delivery ledger for the YouTube / community monitor.
--
-- Root cause of the duplicate-post bug: youtubeMonitor sent an item to Discord
-- BEFORE persisting its "seen" marker (sources.last_post_id / last_post_signature).
-- A crash, a failed marker write, a job retry, or two concurrent pollers could
-- therefore re-deliver the same video or community post. The single-latest-id
-- marker also carried no per-item history to fall back on.
--
-- This table lets the monitor atomically CLAIM an item right before sending
-- (INSERT ... ON CONFLICT DO NOTHING). If the row already exists the item was
-- already delivered, so re-delivery becomes structurally impossible regardless
-- of restarts, retries, or races. Keyed per source so the same video posted to
-- two different Discord channels (two sources) is still delivered to each.

create table if not exists public.muel_youtube_deliveries (
  source_id    bigint      not null,
  youtube_id   text        not null,
  kind         text        not null default 'unknown',
  channel_id   text,
  delivered_at timestamptz not null default now(),
  primary key (source_id, youtube_id)
);

create index if not exists muel_youtube_deliveries_delivered_at_idx
  on public.muel_youtube_deliveries (delivered_at desc);

-- Backend (service_role) only. RLS enabled with no policies => anon and
-- authenticated roles have no access; the bot's service-role client bypasses
-- RLS. Keeps the linter/advisors happy without exposing the ledger publicly.
alter table public.muel_youtube_deliveries enable row level security;
