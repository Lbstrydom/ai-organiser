-- Global tables: prompt_variants, adjudication_events, suppression_events

CREATE TABLE IF NOT EXISTS {{SCHEMA}}prompt_variants (
  pass_name TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  text TEXT,
  updated_at {{TIMESTAMPTZ}} NOT NULL,
  PRIMARY KEY (pass_name, variant_id)
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}adjudication_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  fingerprint TEXT,
  event_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}suppression_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  result_json {{JSONB}},
  created_at {{TIMESTAMPTZ}} NOT NULL
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}schema_version (
  v INTEGER NOT NULL PRIMARY KEY
);

INSERT OR IGNORE INTO {{SCHEMA}}schema_version (v) VALUES (1);
