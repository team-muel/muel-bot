-- SEC-1: Weave RPC 들은 SECURITY DEFINER 이므로 anon/authenticated 가 PostgREST 로
-- 직접 호출하면 Next API 의 requireDiscordUser 인증을 우회할 수 있었다(공개 anon 키 + 임의 uid).
-- 직접 실행 권한을 회수하고 service_role(Next API service client)만 호출하도록 제한.
revoke execute on function public.weave_user_memories(text) from anon, authenticated, public;
revoke execute on function public.weave_server_overview() from anon, authenticated, public;
grant execute on function public.weave_user_memories(text) to service_role;
grant execute on function public.weave_server_overview() to service_role;