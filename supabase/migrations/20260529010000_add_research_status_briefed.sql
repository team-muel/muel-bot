-- Grounding-first research flow: a 'briefed' row is created when the user gets
-- the immediate grounded brief, before (and only if) they opt into AI-Q deep
-- research via the "더 깊게 조사" button.

alter table public.muel_research_jobs drop constraint if exists muel_research_jobs_status_check;
alter table public.muel_research_jobs add constraint muel_research_jobs_status_check
  check (status = any (array['briefed','submitted','running','success','failure','cancelled','timeout','denied']));
