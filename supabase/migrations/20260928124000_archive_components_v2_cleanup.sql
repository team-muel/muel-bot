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
     set content = null,
         tombstoned = true,
         tombstoned_at = now(),
         tombstone_reason = p_reason
   where message_id = p_message_id;

  delete from message_versions where message_id = p_message_id;
  delete from message_embeds where message_id = p_message_id;
  delete from message_components where message_id = p_message_id;
  delete from message_rich_text where message_id = p_message_id;
end
$function$;

revoke all on function archive.tombstone_message(text,text) from public, anon, authenticated;
grant execute on function archive.tombstone_message(text,text) to service_role;

alter table archive.messages
  drop column if exists rich_content;
