-- Core tables: repos, audit_runs, audit_findings, audit_pass_stats
-- Dialect tokens expanded at runtime: {{JSONB}}, {{TIMESTAMPTZ}}, {{SCHEMA}}

CREATE TABLE IF NOT EXISTS {{SCHEMA}}repos (
  repo_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  profile_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL,
  updated_at {{TIMESTAMPTZ}} NOT NULL
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}audit_runs (
  run_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  plan_file TEXT,
  mode TEXT,
  started_at {{TIMESTAMPTZ}} NOT NULL,
  completed_at {{TIMESTAMPTZ}},
  stats_json {{JSONB}}
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_repo ON {{SCHEMA}}audit_runs (repo_id);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}audit_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  finding_hash TEXT NOT NULL,
  pass_name TEXT,
  round INTEGER,
  severity TEXT,
  category TEXT,
  detail TEXT,
  created_at {{TIMESTAMPTZ}} NOT NULL,
  UNIQUE(run_id, finding_hash)
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}audit_pass_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  pass_name TEXT NOT NULL,
  stats_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL,
  UNIQUE(run_id, pass_name)
);
