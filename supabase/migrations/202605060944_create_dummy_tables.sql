-- Create dummy tables so that subsequent migrations can run locally
create table if not exists public.muel_conversations (
    id uuid primary key default gen_random_uuid(),
    discord_guild_id text
);

create table if not exists public.muel_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid references public.muel_conversations(id),
    role text,
    direction text,
    discord_user_id text,
    discord_username text,
    content text,
    created_at timestamptz default now()
);
