revoke execute on function public.ensure_pg_cron_job(text, text, text) from public;
revoke execute on function public.ensure_platform_maintenance_cron(integer) from public;
revoke execute on function public.evaluate_platform_hypothetical_indexes(text[]) from public;
revoke execute on function public.get_platform_cron_jobs() from public;
revoke execute on function public.get_platform_pg_statements_top(integer) from public;
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.track_user_activity(text, text, text, bigint) from public;
revoke execute on function public.match_muel_messages(extensions.vector, text, text[], integer) from public;

grant execute on function public.match_muel_messages(extensions.vector, text, text[], integer) to service_role;
grant execute on function public.ensure_pg_cron_job(text, text, text) to service_role;
grant execute on function public.ensure_platform_maintenance_cron(integer) to service_role;
grant execute on function public.evaluate_platform_hypothetical_indexes(text[]) to service_role;
grant execute on function public.get_platform_cron_jobs() to service_role;
grant execute on function public.get_platform_pg_statements_top(integer) to service_role;
grant execute on function public.rls_auto_enable() to service_role;
grant execute on function public.track_user_activity(text, text, text, bigint) to service_role;

alter function public.set_updated_at() set search_path = public, pg_temp;
