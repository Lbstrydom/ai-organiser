-- ============================================================================
-- Migration: 20260520120000_consistency_source_kinds.sql
-- Plan: docs/plans/persona-test-consistency-mode.md — Phase 0 contract layer
--
-- Purpose: Extend regression_specs to support the consistency-mode
-- candidate-then-locked artifact lifecycle without a new table.
--
-- This migration is ADDITIVE — existing rows are untouched, applied
-- migrations stay immutable, and downstream views are re-created via
-- CREATE OR REPLACE so their bodies stay in sync with the new state model.
--
-- Resolves: R2-H3 (no editing applied migrations), R2-H5 (partial unique
-- index doesn't block reborn candidates after lock), R4-H2 (row-shape
-- CHECK by source_kind), R4-M1 (`spec_path` allowed null for candidates),
-- Gemini-R4-G1 (`journey_context` needed for spec rendering),
-- Gemini-R5-G2 (`repo_id IS NOT NULL` in partial unique index),
-- Gemini-R6-G3 (`redaction_count` audit trail column).
--
-- A companion `..._down.sql` reverse script is committed alongside for ops
-- use ONLY — it is NOT auto-run. Forward migrations stay one-way for safety.
-- ============================================================================

-- ── 1. Extend source_kind CHECK ────────────────────────────────────────────
-- Drops and re-adds the constraint with the two new values added (CHECK
-- constraints cannot be ALTERed in-place in standard Postgres).

ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_source_kind_check;
ALTER TABLE regression_specs ADD  CONSTRAINT regression_specs_source_kind_check
  CHECK (source_kind IN (
    'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
    'plan-frontend-verify', 'plan-backend-verify',
    'persona-consistency-candidate', 'persona-consistency-locked',
    'manual', 'other'
  ));

-- ── 2. Allow spec_path NULL on candidate rows ──────────────────────────────
-- Candidate rows exist in the DB before any file is written; spec_path is
-- populated only at promotion. Locked / manual / other rows still require
-- spec_path NOT NULL — enforced by the row-shape CHECK in step 4.

ALTER TABLE regression_specs ALTER COLUMN spec_path DROP NOT NULL;

-- ── 3. New nullable columns ─────────────────────────────────────────────────
-- All NULLABLE so existing rows accept the column add without backfill.
-- Row-shape CHECK in step 4 enforces "required for candidates" semantics.

ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS candidate_fingerprint TEXT;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS witness_snapshot      JSONB;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS contradiction_payload JSONB;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS journey_context       JSONB;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS promoted_at           TIMESTAMPTZ;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS promoted_by           TEXT;
ALTER TABLE regression_specs ADD COLUMN IF NOT EXISTS redaction_count       INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN regression_specs.candidate_fingerprint IS
  'sha256(repoId+journeyKey+surfaceId+engineField+contradictionKind+normalisedLocator). Candidate-only.';
COMMENT ON COLUMN regression_specs.witness_snapshot IS
  'JSON-encoded WitnessRecord at the moment of contradiction. Required for candidate + locked.';
COMMENT ON COLUMN regression_specs.contradiction_payload IS
  'JSON-encoded Contradiction record. Required for candidate + locked.';
COMMENT ON COLUMN regression_specs.journey_context IS
  'Slice of canary.journeySteps + authBootstrap + routes needed to navigate back to the contradicted state. Required for candidate + locked.';
COMMENT ON COLUMN regression_specs.promoted_at IS
  'Set when source_kind transitions candidate → locked.';
COMMENT ON COLUMN regression_specs.promoted_by IS
  'Git user.email (or null) recorded at promotion.';
COMMENT ON COLUMN regression_specs.redaction_count IS
  'Number of secret-pattern hits redacted from JSONB columns before write. Egress-audit trail.';

-- ── 4. Row-shape CHECK by source_kind ──────────────────────────────────────
-- Enforces the lifecycle invariant: candidates carry witness/contradiction/
-- journey context but no spec_path/promotion fields; locked rows have all
-- six; pre-existing source_kinds keep the original shape.

ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_row_shape_check;
ALTER TABLE regression_specs ADD  CONSTRAINT regression_specs_row_shape_check
  CHECK (
    -- Pre-existing source kinds: spec_path required; consistency columns must be null.
    (source_kind IN (
      'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
      'plan-frontend-verify', 'plan-backend-verify',
      'manual', 'other'
    )
      AND spec_path IS NOT NULL
      AND candidate_fingerprint IS NULL
      AND witness_snapshot      IS NULL
      AND contradiction_payload IS NULL
      AND journey_context       IS NULL
      AND promoted_at           IS NULL
      AND promoted_by           IS NULL)
    OR
    -- Candidate: witness/contradiction/journey/fingerprint required; spec_path + promotion forbidden.
    (source_kind = 'persona-consistency-candidate'
      AND spec_path             IS NULL
      AND candidate_fingerprint IS NOT NULL
      AND witness_snapshot      IS NOT NULL
      AND contradiction_payload IS NOT NULL
      AND journey_context       IS NOT NULL
      AND promoted_at           IS NULL
      AND promoted_by           IS NULL)
    OR
    -- Locked: all six populated.
    (source_kind = 'persona-consistency-locked'
      AND spec_path             IS NOT NULL
      AND candidate_fingerprint IS NOT NULL
      AND witness_snapshot      IS NOT NULL
      AND contradiction_payload IS NOT NULL
      AND journey_context       IS NOT NULL
      AND promoted_at           IS NOT NULL)
  );

-- ── 5. Partial unique index on candidate fingerprint ───────────────────────
-- Prevents duplicate candidate rows for the same (repo, fingerprint) on
-- reruns, while leaving locked rows free to coexist (allowing the same
-- contradiction to re-surface as a candidate after its lock has been
-- deleted). The `repo_id IS NOT NULL` predicate is load-bearing — without
-- it, NULL repo_ids would silently allow duplicates (Postgres treats NULL
-- as distinct in unique indexes).

CREATE UNIQUE INDEX IF NOT EXISTS idx_regression_specs_candidate_fingerprint
  ON regression_specs (repo_id, candidate_fingerprint)
  WHERE candidate_fingerprint IS NOT NULL
    AND source_kind            = 'persona-consistency-candidate'
    AND repo_id                IS NOT NULL;

-- Lookup index for /ship's candidate batch promote.
CREATE INDEX IF NOT EXISTS idx_regression_specs_pending_candidates
  ON regression_specs (repo_id, created_at)
  WHERE source_kind = 'persona-consistency-candidate';

-- ── 6. View re-creation: unlocked_fixes excludes consistency candidates ────
-- The original view filters by `source_finding_type = 'audit'`, which
-- already excludes candidates structurally (they have NULL source_finding_type).
-- We re-create the view explicitly with an extra source_kind NOT IN guard
-- so future shape changes can't silently leak candidate rows into the
-- "unlocked" count. Body otherwise identical to the 20260419120000 version.

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
      AND rs.source_kind         NOT IN ('persona-consistency-candidate')
  ) AS lock_spec_count
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.severity = 'HIGH'
  AND f.adjudication_outcome = 'accepted'
  AND f.remediation_state IN ('fixed', 'verified')
  AND r.created_at > now() - interval '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
      AND rs.source_kind         NOT IN ('persona-consistency-candidate')
  );

-- Note on ship_gate_effectiveness: the existing view unrolls
-- ship_events.block_reasons as a JSONB array, so any new block reason code
-- (including 'persona-consistency-candidate-pending' when /ship emits it)
-- appears in the rollup automatically. No view re-creation needed.
