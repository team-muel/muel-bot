grant usage on schema mafia to service_role;
grant all privileges on all tables in schema mafia to service_role;
grant all privileges on all sequences in schema mafia to service_role;
grant execute on all functions in schema mafia to service_role;

alter default privileges in schema mafia grant all privileges on tables to service_role;
alter default privileges in schema mafia grant all privileges on sequences to service_role;
alter default privileges in schema mafia grant execute on functions to service_role;
