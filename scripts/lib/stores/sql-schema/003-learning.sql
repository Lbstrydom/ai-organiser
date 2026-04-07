-- Learning tables: bandit_arms, false_positive_patterns

CREATE TABLE IF NOT EXISTS {{SCHEMA}}bandit_arms (
  repo_id TEXT NOT NULL PRIMARY KEY,
  arms_json {{JSONB}},
  updated_at {{TIMESTAMPTZ}} NOT NULL
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}fp_patterns (
  repo_id TEXT NOT NULL PRIMARY KEY,
  patterns_json {{JSONB}},
  updated_at {{TIMESTAMPTZ}} NOT NULL
);
