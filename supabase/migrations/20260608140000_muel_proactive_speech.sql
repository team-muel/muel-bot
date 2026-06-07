-- 프로액티브(먼저 말 걸기) 채널 옵트인 + 길드 의례 상태. bot=service_role → RLS enable, no policy.
create table if not exists public.muel_proactive_configs (
  guild_id text not null,
  channel_id text not null,
  enabled boolean not null default true,
  morning boolean not null default true,
  spike boolean not null default true,
  last_spoke_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (guild_id, channel_id)
);
alter table public.muel_proactive_configs enable row level security;

create table if not exists public.muel_proactive_guild_state (
  guild_id text primary key,
  last_morning_date text,
  updated_at timestamptz not null default now()
);
alter table public.muel_proactive_guild_state enable row level security;