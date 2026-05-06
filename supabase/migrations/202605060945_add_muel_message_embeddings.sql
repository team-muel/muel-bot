create extension if not exists vector with schema extensions;

alter table public.muel_messages
  add column if not exists embedding extensions.vector(1536);

create index if not exists muel_messages_embedding_hnsw_idx
  on public.muel_messages
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.match_muel_messages(
  query_embedding extensions.vector(1536),
  match_guild_id text default null,
  match_user_ids text[] default null,
  match_count int default 8
)
returns table (
  id uuid,
  conversation_id uuid,
  role text,
  direction text,
  discord_user_id text,
  discord_username text,
  content text,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    m.id,
    m.conversation_id,
    m.role,
    m.direction,
    m.discord_user_id,
    m.discord_username,
    m.content,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.muel_messages m
  join public.muel_conversations c on c.id = m.conversation_id
  where m.embedding is not null
    and m.content <> ''
    and (match_guild_id is null or c.discord_guild_id = match_guild_id)
    and (
      match_user_ids is null
      or cardinality(match_user_ids) = 0
      or m.discord_user_id = any(match_user_ids)
    )
  order by m.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 20);
$$;
