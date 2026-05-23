-- ============================================================================
-- Cross-Skill Data Loop — close the feedback gaps between the 6 skills so
-- persona-test findings become ground-truth labels for audit-loop's learning
-- system, and /ux-lock + /ship participate in the same outcome store.
-- ============================================================================
-- Tables introduced:
--   plans                        — plan-backend/plan-frontend artefact registry
--   regression_specs             — /ux-lock-authored Playwright specs
--   regression_spec_runs         — per-run pass/fail history for each spec
--   persona_audit_correlations   — persona_finding ↔ audit_finding mapping
--   ship_events                  — /ship outcomes (block / override / warn)
-- Columns added:
--   audit_runs.commit_sha, audit_runs.plan_id
--   persona_test_sessions.commit_sha, persona_test_sessions.deployment_id
-- All additive + idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. commit_sha on audit_runs + persona_test_sessions ─────────────────────

ALTER TABLE audit_runs       ADD COLUMN IF NOT EXISTS commit_sha    TEXT;
ALTER TABLE audit_runs       ADD COLUMN IF NOT EXISTS branch        TEXT;
ALTER TABLE persona_test_sessions ADD COLUMN IF NOT EXISTS commit_sha    TEXT;
ALTER TABLE persona_test_sessions ADD COLUMN IF NOT EXISTS deployment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_runs_commit           ON audit_runs       (commit_sha)            WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_persona_sessions_commit     ON persona_test_sessions (commit_sha)       WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_persona_sessions_deployment ON persona_test_sessions (deployment_id)    WHERE deployment_id IS NOT NULL;

-- ── 2. plans — store planning-skill artefacts & link to audit runs ──────────

CREATE TABLE IF NOT EXISTS plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id          UUID REFERENCES audit_repos(id) ON DELETE SET NULL,
  path             TEXT NOT NULL,
  skill            TEXT NOT NULL CHECK (skill IN ('plan-backend', 'plan-frontend', 'manual', 'other')),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'complete', 'abandoned')),
  principles_cited JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of principle identifiers the plan references
  focus_areas      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- e.g. ["backend", "auth", "api"]
  commit_sha       TEXT,                                -- commit the plan was authored against
  checksum         TEXT,                                -- sha256 of plan markdown for drift detection
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, path)
);

CREATE INDEX IF NOT EXISTS idx_plans_repo   ON plans (repo_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans (status);

-- Link audit_runs back to the plan artefact (NULL for ad-hoc runs)
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_runs_plan ON audit_runs (plan_id) WHERE plan_id IS NOT NULL;

-- ── 3. regression_specs — /ux-lock persistence ──────────────────────────────

CREATE TABLE IF NOT EXISTS regression_specs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id              UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  spec_path            TEXT NOT NULL,                   -- e.g. tests/e2e/fix-modal-close.spec.js
  description          TEXT NOT NULL,                   -- one-line description of the fix being locked
  commit_sha           TEXT,                            -- the commit the spec was generated against
  assertion_count      INTEGER NOT NULL DEFAULT 0,
  dom_contract_types   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- array of contract types asserted on: "role", "aria-*", "data-testid",
    -- "navigation", "visibility", "count", "axe" (WCAG), "text", "attribute"
  source_kind          TEXT NOT NULL CHECK (source_kind IN (
    'audit-loop-fix', 'persona-test-p0', 'persona-test-p1', 'manual', 'other'
  )),
  source_finding_id    UUID,                            -- weak ref: audit_findings.id OR persona finding hash
  source_finding_type  TEXT CHECK (source_finding_type IN ('audit', 'persona', NULL)),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, spec_path)
);

CREATE INDEX IF NOT EXISTS idx_regression_specs_repo    ON regression_specs (repo_id);
CREATE INDEX IF NOT EXISTS idx_regression_specs_source  ON regression_specs (source_kind, source_finding_id);

-- Append-only run history: did the spec pass? did it catch a regression?
CREATE TABLE IF NOT EXISTS regression_spec_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id              UUID NOT NULL REFERENCES regression_specs(id) ON DELETE CASCADE,
  commit_sha           TEXT,
  passed               BOOLEAN NOT NULL,
  captured_regression  BOOLEAN NOT NULL DEFAULT FALSE,
    -- TRUE when the spec failed on a commit that was supposed to preserve the contract
    -- → this is a "save" attributable to the regression lock
  duration_ms          INTEGER,
  error_message        TEXT,
  run_context          TEXT CHECK (run_context IN ('ship-gate', 'ci', 'manual', 'ux-lock-verify')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_regression_spec_runs_spec    ON regression_spec_runs (spec_id);
CREATE INDEX IF NOT EXISTS idx_regression_spec_runs_capture ON regression_spec_runs (captured_regression) WHERE captured_regression = TRUE;

-- ── 4. persona_audit_correlations — the ground-truth labelling feed ─────────

CREATE TABLE IF NOT EXISTS persona_audit_correlations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_session_id      UUID NOT NULL REFERENCES persona_test_sessions(id) ON DELETE CASCADE,
  persona_finding_hash    TEXT NOT NULL,
    -- content hash of the persona finding (element + observed + severity), stable across sessions
  persona_severity        TEXT NOT NULL CHECK (persona_severity IN ('P0', 'P1', 'P2', 'P3')),
  audit_finding_id        UUID REFERENCES audit_findings(id) ON DELETE SET NULL,
    -- NULL when the persona found something the audit never flagged (audit_missed)
  audit_run_id            UUID REFERENCES audit_runs(id) ON DELETE SET NULL,
  correlation_type        TEXT NOT NULL CHECK (correlation_type IN (
    'confirmed_hit',      -- persona saw a real user-visible symptom that audit had flagged
    'audit_missed',       -- persona saw an issue audit never raised
    'audit_false_positive', -- audit flagged something persona could not reproduce
    'severity_understated', -- audit had it as LOW/MEDIUM but user impact is P0
    'severity_overstated'   -- audit had it as HIGH but user impact is P2/P3
  )),
  match_score             NUMERIC(4,3),                 -- 0.0–1.0 similarity score (file/keyword overlap)
  match_rationale         TEXT,                         -- one-line explanation of the correlation
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one correlation row per (session, persona_finding, audit_finding) tuple
  UNIQUE (persona_session_id, persona_finding_hash, audit_finding_id)
);

CREATE INDEX IF NOT EXISTS idx_correlations_session       ON persona_audit_correlations (persona_session_id);
CREATE INDEX IF NOT EXISTS idx_correlations_audit_finding ON persona_audit_correlations (audit_finding_id) WHERE audit_finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_correlations_type          ON persona_audit_correlations (correlation_type);
CREATE INDEX IF NOT EXISTS idx_correlations_audit_run     ON persona_audit_correlations (audit_run_id) WHERE audit_run_id IS NOT NULL;

-- ── 5. ship_events — /ship outcomes ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ship_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id                  UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  commit_sha               TEXT,
  branch                   TEXT,
  outcome                  TEXT NOT NULL CHECK (outcome IN (
    'shipped', 'blocked', 'warned', 'overridden', 'aborted'
  )),
  block_reasons            JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- array of reason codes: "test-failure", "lint-failure", "type-check-failure",
    -- "format-failure", "open-p0", "missing-regression-spec", "secrets-detected"
  open_p0_count            INTEGER NOT NULL DEFAULT 0,
  open_p1_count            INTEGER NOT NULL DEFAULT 0,
  missing_spec_count       INTEGER NOT NULL DEFAULT 0,
    -- number of recent audit-fixes or persona-P0-fixes with no /ux-lock spec
  overridden_by_user       BOOLEAN NOT NULL DEFAULT FALSE,
  override_flag            TEXT,                        -- e.g. "--no-tests", "--ignore-p0"
  stack_detected           TEXT,                        -- "js-ts", "python", "mixed", "unknown"
  framework                TEXT,                        -- "fastapi", "django", "flask", etc. (optional)
  duration_ms              INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ship_events_repo    ON ship_events (repo_id);
CREATE INDEX IF NOT EXISTS idx_ship_events_commit  ON ship_events (commit_sha) WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ship_events_outcome ON ship_events (outcome);

-- ── 6. Rollup views — cross-skill observability ─────────────────────────────

-- Audit precision weighted by user-visible impact (the metric that matters):
--   precision_confirmed = confirmed_hit / (confirmed_hit + audit_false_positive)
--   recall_user_visible = confirmed_hit / (confirmed_hit + audit_missed)
CREATE OR REPLACE VIEW audit_effectiveness AS
SELECT
  r.id                                                  AS repo_id,
  r.name                                                AS repo_name,
  COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')        AS confirmed_hits,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_missed')         AS audit_misses,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_false_positive') AS audit_false_positives,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_understated') AS severity_understated,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_overstated')  AS severity_overstated,
  -- Weighted precision
  ROUND(
    NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0
    ) / NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_false_positive'))::numeric, 0
    ),
    3
  ) AS user_visible_precision,
  -- Weighted recall
  ROUND(
    NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0
    ) / NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_missed'))::numeric, 0
    ),
    3
  ) AS user_visible_recall
FROM audit_repos r
LEFT JOIN persona_test_sessions s ON s.repo_name = r.name
LEFT JOIN persona_audit_correlations c ON c.persona_session_id = s.id
GROUP BY r.id, r.name;

-- Regression spec coverage: which recent HIGH-severity fixes lack a lock spec?
CREATE OR REPLACE VIEW unlocked_fixes AS
SELECT
  f.id                           AS audit_finding_id,
  f.run_id                       AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  r.created_at                   AS fixed_at,
  (
    SELECT COUNT(*) FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
  ) AS lock_spec_count
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.severity = 'HIGH'
  AND f.adjudication_outcome = 'accepted'
  AND f.remediation_state IN ('fixed', 'verified')
  AND r.created_at > now() - interval '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit' AND rs.source_finding_id = f.id
  );

-- Regression specs that have saved us (captured a real regression)
CREATE OR REPLACE VIEW regression_saves AS
SELECT
  rs.id                 AS spec_id,
  rs.spec_path,
  rs.description,
  rs.source_kind,
  rr.commit_sha,
  rr.error_message,
  rr.created_at         AS caught_at
FROM regression_specs rs
JOIN regression_spec_runs rr ON rr.spec_id = rs.id
WHERE rr.captured_regression = TRUE
ORDER BY rr.created_at DESC;

-- Ship gate hit rate — how often does each block reason actually fire?
CREATE OR REPLACE VIEW ship_gate_effectiveness AS
SELECT
  reason.value                    AS reason_code,
  COUNT(*)                        AS occurrences,
  COUNT(*) FILTER (WHERE se.overridden_by_user = TRUE) AS overridden,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE se.overridden_by_user = TRUE) / NULLIF(COUNT(*), 0),
    1
  )                               AS override_pct
FROM ship_events se,
     jsonb_array_elements_text(se.block_reasons) AS reason
GROUP BY reason.value
ORDER BY occurrences DESC;

-- ── 7. RLS — match existing anon-permissive pattern for CLI tool ────────────

ALTER TABLE plans                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_specs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_spec_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE persona_audit_correlations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_events                 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_plans"                      ON plans;
DROP POLICY IF EXISTS "anon_all_regression_specs"           ON regression_specs;
DROP POLICY IF EXISTS "anon_all_regression_spec_runs"       ON regression_spec_runs;
DROP POLICY IF EXISTS "anon_all_persona_audit_correlations" ON persona_audit_correlations;
DROP POLICY IF EXISTS "anon_all_ship_events"                ON ship_events;

CREATE POLICY "anon_all_plans"                      ON plans                      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_regression_specs"           ON regression_specs           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_regression_spec_runs"       ON regression_spec_runs       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_persona_audit_correlations" ON persona_audit_correlations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_ship_events"                ON ship_events                FOR ALL USING (true) WITH CHECK (true);
