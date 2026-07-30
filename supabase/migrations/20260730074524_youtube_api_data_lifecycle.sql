-- Track freshness of public YouTube Data API fields independently from Muel's
-- own observation timestamp. YouTube's developer policy requires public
-- non-authorized API data to be refreshed or deleted within 30 days.

alter table public.muel_youtube_items
  add column if not exists api_refreshed_at timestamptz,
  add column if not exists stats_refreshed_at timestamptz;

update public.muel_youtube_items
set
  api_refreshed_at = coalesce(api_refreshed_at, last_seen_at, created_at),
  stats_refreshed_at = coalesce(stats_refreshed_at, last_seen_at, created_at)
where kind in ('video', 'shorts');

create index if not exists muel_youtube_items_api_refresh_idx
  on public.muel_youtube_items (api_refreshed_at asc nulls first)
  where kind in ('video', 'shorts');

create index if not exists muel_youtube_items_stats_refresh_idx
  on public.muel_youtube_items (stats_refreshed_at asc nulls first)
  where kind in ('video', 'shorts');
