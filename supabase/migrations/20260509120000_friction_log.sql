-- Friction Log v1
--
-- Plan: docs/plans/friction-log-and-digest-v1.md
--
-- Captures real-time operator annoyance (`npm run audit:wtf "..."`) so
-- the dogfooding cycle generates qualitative signal that complements the
-- quantitative learning_decisions telemetry.  Service-role-only — same
-- RLS pattern as Phase 1 learning_decisions.

CREATE TABLE IF NOT EXISTS friction_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id      uuid REFERENCES audit_repos(id) ON DELETE SET NULL,
  audit_run_id uuid REFERENCES audit_runs(id)  ON DELETE SET NULL,
  message      text NOT NULL,
  cwd          text,
  severity     text NOT NULL DEFAULT 'note'
    CHECK (severity IN ('note','annoyance','blocker')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS friction_log_repo_created_idx
  ON friction_log (repo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS friction_log_severity_created_idx
  ON friction_log (severity, created_at DESC);

ALTER TABLE friction_log ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only.
