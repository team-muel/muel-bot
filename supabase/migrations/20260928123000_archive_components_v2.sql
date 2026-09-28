alter table archive.messages
  add column if not exists rich_content text;

create table if not exists archive.message_components (
  message_id text not null references archive.messages(message_id) on delete cascade,
  component_index integer not null check (component_index >= 0),
  component_type integer not null,
  text_projection text,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, component_index)
);

alter table archive.message_components enable row level security;
revoke all on archive.message_components from public, anon, authenticated;
grant select, insert, update, delete on archive.message_components to service_role;

create table if not exists archive.message_rich_text (
  message_id text primary key references archive.messages(message_id) on delete cascade,
  rendered_text text not null default '',
  updated_at timestamptz not null default now()
);

alter table archive.message_rich_text enable row level security;
revoke all on archive.message_rich_text from public, anon, authenticated;
grant select, insert, update, delete on archive.message_rich_text to service_role;

create or replace view archive.v_messages
with (security_invoker = true)
as
select
  m.message_id,
  m.channel_id,
  m.guild_id,
  m.created_at,
  m.edited_at,
  case when m.tombstoned then '[작성자 요청으로 삭제됨]'::text else m.content end as content,
  coalesce(a.display_name,a.pseudonym) as author_display,
  a.mask_state,
  a.author_ref,
  m.reply_to_message_id,
  m.has_attachments,
  m.tombstoned,
  case when m.tombstoned then '[작성자 요청으로 삭제됨]'::text
       else coalesce(nullif(r.rendered_text,''),m.content) end as rendered_text,
  exists(select 1 from archive.message_embeds e where e.message_id=m.message_id) as has_embeds,
  exists(select 1 from archive.message_components c where c.message_id=m.message_id) as has_components
from archive.messages m
left join archive.authors a on a.author_ref=m.author_ref
left join archive.message_rich_text r on r.message_id=m.message_id;

revoke all on archive.v_messages from public, anon, authenticated;
grant select on archive.v_messages to service_role;

create or replace function archive.tombstone_message(
  p_message_id text,
  p_reason text default 'erasure_request'
)
returns void
language plpgsql
security definer
set search_path to 'archive'
as $function$
begin
  update messages
     set content=null,
         rich_content=null,
         tombstoned=true,
         tombstoned_at=now(),
         tombstone_reason=p_reason
   where message_id=p_message_id;
  delete from message_versions where message_id=p_message_id;
  delete from message_embeds where message_id=p_message_id;
  delete from message_components where message_id=p_message_id;
  delete from message_rich_text where message_id=p_message_id;
end
$function$;

revoke all on function archive.tombstone_message(text,text) from public, anon, authenticated;
grant execute on function archive.tombstone_message(text,text) to service_role;
