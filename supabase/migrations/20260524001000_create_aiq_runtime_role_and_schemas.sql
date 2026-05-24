-- 20260524001000_create_aiq_runtime_role_and_schemas.sql
-- AI-Q integration: least-privilege Postgres role + isolated schemas.
--
-- The aiq_runtime role is created NOLOGIN. Before deploying AI-Q backend,
-- set its password in a separate one-shot SQL (do not commit the password):
--
--   ALTER ROLE aiq_runtime WITH LOGIN PASSWORD '<strong-random>';
--
-- Then store the password in GCP Secret Manager as part of the Supabase
-- connection URL for AI-Q backend env vars (NAT_JOB_STORE_DB_URL etc.).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiq_runtime') THEN
    CREATE ROLE aiq_runtime NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS aiq_jobs;
CREATE SCHEMA IF NOT EXISTS aiq_checkpoints;

-- AI-Q role owns its own schemas and nothing else.
GRANT USAGE, CREATE ON SCHEMA aiq_jobs TO aiq_runtime;
GRANT USAGE, CREATE ON SCHEMA aiq_checkpoints TO aiq_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA aiq_jobs
  GRANT ALL ON TABLES TO aiq_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA aiq_jobs
  GRANT ALL ON SEQUENCES TO aiq_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA aiq_checkpoints
  GRANT ALL ON TABLES TO aiq_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA aiq_checkpoints
  GRANT ALL ON SEQUENCES TO aiq_runtime;

-- Defense in depth: explicitly REVOKE muel data access from aiq_runtime.
-- Schema USAGE on public is granted to PUBLIC by Postgres default — that's fine
-- because we deny every table individually. Reading muel data requires both
-- schema USAGE AND table SELECT; with no table grants the role cannot read.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aiq_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM aiq_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM aiq_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM aiq_runtime;

-- Prevent anon/authenticated API access to AI-Q internal schemas.
REVOKE ALL ON SCHEMA aiq_jobs FROM anon, authenticated;
REVOKE ALL ON SCHEMA aiq_checkpoints FROM anon, authenticated;
