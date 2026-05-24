-- 20260524001100_aiq_init_job_info.sql
-- AI-Q NAT JobStore initial schema, translated from upstream
-- deploy/compose/init-db.sql to schema-based form for Supabase single-DB.
--
-- Other AI-Q tables (job_events, LangGraph checkpoints, summaries) are
-- auto-created at runtime by the AI-Q app code (event_store.py,
-- AsyncPostgresSaver, summary_store.py).

CREATE TABLE IF NOT EXISTS aiq_jobs.job_info (
  job_id VARCHAR PRIMARY KEY,
  status VARCHAR NOT NULL,
  config_file VARCHAR,
  error VARCHAR,
  output_path VARCHAR,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  expiry_seconds INTEGER,
  output VARCHAR,
  is_expired BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_job_info_status ON aiq_jobs.job_info(status);
CREATE INDEX IF NOT EXISTS idx_job_info_created_at ON aiq_jobs.job_info(created_at);

GRANT ALL ON TABLE aiq_jobs.job_info TO aiq_runtime;
