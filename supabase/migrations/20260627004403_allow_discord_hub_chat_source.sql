alter table public.muel_chats
  drop constraint if exists muel_chats_source_check;

alter table public.muel_chats
  add constraint muel_chats_source_check
  check (source in ('discord', 'discord_hub', 'web', 'slack', 'system'));
