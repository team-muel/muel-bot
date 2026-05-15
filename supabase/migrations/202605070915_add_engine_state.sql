-- Add JSON columns for the Rule Engine state

alter table mafia.matches 
add column if not exists engine_state jsonb not null default '{}'::jsonb;

alter table mafia.match_players 
add column if not exists engine_state jsonb not null default '{}'::jsonb;
