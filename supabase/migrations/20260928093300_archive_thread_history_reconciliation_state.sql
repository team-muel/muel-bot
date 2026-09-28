alter table archive.channels
  add column if not exists history_reconcile_cursor text,
  add column if not exists history_reconcile_version integer not null default 0,
  add column if not exists history_reconciled_at timestamptz;

create index if not exists archive_channels_thread_reconcile_idx
  on archive.channels (history_reconcile_version, updated_at desc)
  where type in ('GuildPublicThread','GuildNewsThread');
