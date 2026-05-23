-- ============================================================================
-- Plan Verify — /ux-lock verify <plan.md> mode persistence
-- ============================================================================
-- Each plan-frontend plan (Section 9: Acceptance Criteria) becomes a set of
-- Playwright-verifiable criteria. /ux-lock verify generates a spec file and
-- runs it; this migration stores the per-criterion outcomes so plans can be
-- graded against their implementation over time.
--
-- Tables:
--   plan_verification_runs   — one row per /ux-lock verify invocation
--   plan_verification_items  — one row per criterion outcome (stable hash)
-- View:
--   plan_satisfaction        — latest run rollup + failing P0 list
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS plan_verification_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  spec_id         UUID REFERENCES regression_specs(id) ON DELETE SET NULL,
    -- the generated spec file (housed in regression_specs with source_kind = 'plan-frontend-verify')
  commit_sha      TEXT,
  url             TEXT,                     -- base URL the verify ran against
  total_criteria  INTEGER NOT NULL DEFAULT 0,
  passed_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  run_context     TEXT CHECK (run_context IN ('ux-lock-verify', 'ci', 'manual')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pvr_plan    ON plan_verification_runs (plan_id);
CREATE INDEX IF NOT EXISTS idx_pvr_created ON plan_verification_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS plan_verification_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES plan_verification_runs(id) ON DELETE CASCADE,
  plan_id         UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  criterion_hash  TEXT NOT NULL,
    -- sha256 of severity|category|description — stable across runs,
    -- enabling per-criterion time-series analysis
  criterion_index INTEGER NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  category        TEXT NOT NULL CHECK (category IN (
    'visibility', 'interaction', 'a11y', 'state', 'responsive', 'text', 'navigation', 'other'
  )),
  description     TEXT NOT NULL,
  setup_text      TEXT,                    -- raw "Setup:" line from plan
  assert_text     TEXT,                    -- raw "Assert:" line from plan
  passed          BOOLEAN NOT NULL,
  error_message   TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pvi_run    ON plan_verification_items (run_id);
CREATE INDEX IF NOT EXISTS idx_pvi_plan   ON plan_verification_items (plan_id);
CREATE INDEX IF NOT EXISTS idx_pvi_hash   ON plan_verification_items (criterion_hash);
CREATE INDEX IF NOT EXISTS idx_pvi_failed ON plan_verification_items (passed) WHERE passed = FALSE;

-- Extend regression_specs CHECK constraints to allow plan-verify rows.
-- PostgreSQL rebuilds constraints by drop/add — safe, additive.
ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_source_kind_check;
ALTER TABLE regression_specs ADD  CONSTRAINT regression_specs_source_kind_check
  CHECK (source_kind IN (
    'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
    'plan-frontend-verify', 'plan-backend-verify',
    'manual', 'other'
  ));

ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_source_finding_type_check;
ALTER TABLE regression_specs ADD  CONSTRAINT regression_specs_source_finding_type_check
  CHECK (source_finding_type IS NULL OR source_finding_type IN ('audit', 'persona', 'plan'));

-- Rollup view — plan satisfaction with failing-P0 detail
CREATE OR REPLACE VIEW plan_satisfaction AS
SELECT
  p.id                                                  AS plan_id,
  p.path                                                AS plan_path,
  p.skill                                               AS plan_skill,
  p.status                                              AS plan_status,
  r.id                                                  AS latest_run_id,
  r.created_at                                          AS last_verified_at,
  r.commit_sha                                          AS verified_commit_sha,
  r.url                                                 AS verified_url,
  r.total_criteria,
  r.passed_count,
  r.failed_count,
  r.skipped_count,
  ROUND(
    NULLIF(100.0 * r.passed_count, 0)::numeric / NULLIF(r.total_criteria, 0),
    1
  )                                                     AS satisfaction_pct,
  -- Failing P0 criteria from the latest run (JSON array of {description, category, error})
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description', i.description,
      'category',    i.category,
      'error',       i.error_message,
      'hash',        i.criterion_hash
    )), '[]'::jsonb)
    FROM plan_verification_items i
    WHERE i.run_id = r.id AND i.passed = FALSE AND i.severity = 'P0'
  )                                                     AS failing_p0_criteria,
  -- Failing P1 criteria from the latest run
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description', i.description,
      'category',    i.category,
      'error',       i.error_message,
      'hash',        i.criterion_hash
    )), '[]'::jsonb)
    FROM plan_verification_items i
    WHERE i.run_id = r.id AND i.passed = FALSE AND i.severity = 'P1'
  )                                                     AS failing_p1_criteria
FROM plans p
LEFT JOIN LATERAL (
  SELECT * FROM plan_verification_runs
  WHERE plan_id = p.id
  ORDER BY created_at DESC
  LIMIT 1
) r ON TRUE;

-- View: criteria that have failed ≥2 consecutive verify runs (regression spotlight)
CREATE OR REPLACE VIEW persistent_plan_failures AS
WITH ranked AS (
  SELECT
    i.plan_id,
    i.criterion_hash,
    i.description,
    i.severity,
    i.category,
    i.passed,
    i.created_at,
    ROW_NUMBER() OVER (PARTITION BY i.plan_id, i.criterion_hash ORDER BY i.created_at DESC) AS rn
  FROM plan_verification_items i
)
SELECT
  plan_id,
  criterion_hash,
  description,
  severity,
  category,
  COUNT(*) FILTER (WHERE NOT passed)                   AS fail_count_last_5,
  MAX(created_at) FILTER (WHERE NOT passed)            AS last_failure_at
FROM ranked
WHERE rn <= 5
GROUP BY plan_id, criterion_hash, description, severity, category
HAVING COUNT(*) FILTER (WHERE NOT passed) >= 2
ORDER BY severity, fail_count_last_5 DESC;

-- RLS — match existing anon-permissive pattern
ALTER TABLE plan_verification_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_verification_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_plan_verification_runs"  ON plan_verification_runs;
DROP POLICY IF EXISTS "anon_all_plan_verification_items" ON plan_verification_items;

CREATE POLICY "anon_all_plan_verification_runs"  ON plan_verification_runs  FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "anon_all_plan_verification_items" ON plan_verification_items FOR ALL USING (TRUE) WITH CHECK (TRUE);
