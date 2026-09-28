create table if not exists archive.message_embeds (
  message_id text not null references archive.messages(message_id) on delete cascade,
  embed_index integer not null check (embed_index >= 0),
  embed_type text,
  title text,
  description text,
  url text,
  color integer,
  embed_timestamp timestamptz,
  author jsonb,
  footer jsonb,
  fields jsonb not null default '[]'::jsonb,
  image jsonb,
  thumbnail jsonb,
  video jsonb,
  provider jsonb,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, embed_index)
);

alter table archive.message_embeds enable row level security;
revoke all on archive.message_embeds from public, anon, authenticated;
grant select, insert, update, delete on archive.message_embeds to service_role;

alter table archive.channels
  add column if not exists embed_reconcile_cursor text,
  add column if not exists embed_reconcile_version integer not null default 0,
  add column if not exists embed_reconcile_requested_at timestamptz,
  add column if not exists embed_reconciled_at timestamptz;

create index if not exists archive_channels_embed_reconcile_idx
  on archive.channels (embed_reconcile_requested_at, embed_reconcile_version, updated_at)
  where embed_reconcile_requested_at is not null;
