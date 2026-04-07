-- Debt tables: debt_entries, debt_events

CREATE TABLE IF NOT EXISTS {{SCHEMA}}debt_entries (
  repo_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  severity TEXT,
  category TEXT,
  detail TEXT,
  payload_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL,
  updated_at {{TIMESTAMPTZ}} NOT NULL,
  PRIMARY KEY (repo_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_debt_entries_repo ON {{SCHEMA}}debt_entries (repo_id);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}debt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  topic_id TEXT,
  event TEXT NOT NULL,
  payload_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_debt_events_repo_ts ON {{SCHEMA}}debt_events (repo_id, created_at);
