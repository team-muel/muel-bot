-- /환영: 서버별 새 멤버 환영 채널 설정. 서버당 1행(guild_id PK).
-- bot 은 service_role 로 접근하므로 RLS enable + no policy (deny-all to anon).
create table if not exists public.muel_welcome_configs (
  guild_id text primary key,
  channel_id text not null,
  enabled boolean not null default true,
  set_by_user_id text,
  updated_at timestamptz not null default now()
);
alter table public.muel_welcome_configs enable row level security;