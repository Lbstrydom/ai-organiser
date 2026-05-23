-- Migration — persona_test_candidates (Phase 3 WS-PIPE1)
--
-- Mirrors wine-cellar-app/data/migrations/139_persona_test_candidates.sql.
-- Both repos connect to the same audit-loop Supabase project (the
-- learning-store DB), so the table is shared. CREATE-IF-NOT-EXISTS makes
-- the migration idempotent against a DB where wine-cellar's migration has
-- already applied (it has — as of 2026-05-21).
--
-- Aggregation table for consistency-mode canary findings — the
-- low-confidence divergences that surface above the canary's severity
-- floor but below the threshold that immediately blocks a CI run.
-- Findings accumulate here across canary runs; `/ship` runs a thresholded
-- query (severity >= P2 + occurrences >= 3 + last_seen <= 7d) and promotes
-- survivors to Playwright spec stubs at
-- tests/e2e/candidates/<fp>.spec.js.proposed.
--
-- Cross-repo isolation (audit-r2/H4):
--   PRIMARY KEY (repo_name, fingerprint) — repo_name is part of the PK,
--   NOT just a column. Identical canary/surface/field tuples in
--   different adopters are stored as DISTINCT rows. Every UPSERT and
--   SELECT in promote-canary-candidates.mjs scopes on
--   (repo_name, fingerprint) — never on fingerprint alone.
--
-- Fingerprint shape (audit-r1/H3 stable key):
--   sha256(canary_name + surfaceId + engineField + scope + key) — same
--   shape as the baseline allowlist (.persona-test/baseline.json) per
--   adopter, so candidate's fingerprint can be checked against the
--   baseline before promotion (don't propose specs already allowlisted).
--
-- RLS posture (audit-r3/M3):
--   ENABLE RLS + no policies for anon/authenticated — default-deny. CI
--   workflow + /ship script both use SUPABASE_AUDIT_SERVICE_KEY
--   (service_role). repo_name is a PARTITION KEY, NOT an authorization
--   boundary — cross-repo write isolation depends on the GitHub Actions
--   secret being repo-scoped, NOT on RLS.
--
-- Plan: wine-cellar-app/docs/plans/persona-test-consistency-phase3.md
--       (WS-PIPE1)

BEGIN;

CREATE TABLE IF NOT EXISTS persona_test_candidates (
  repo_name    TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  canary_name  TEXT NOT NULL,
  surface_id   TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences  INTEGER     NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  proposed_at  TIMESTAMPTZ,
  PRIMARY KEY (repo_name, fingerprint)
);

-- Promotion query support — /ship reads
-- WHERE repo_name = $1 AND last_seen > now() - interval '7 days' AND
--       occurrences >= 3 AND proposed_at IS NULL.
-- Partial-index on the not-yet-proposed slice keeps the query fast even
-- as the historical table grows past the 7-day rolling window.
CREATE INDEX IF NOT EXISTS persona_test_candidates_promotable
  ON persona_test_candidates (repo_name, last_seen DESC, occurrences DESC)
  WHERE proposed_at IS NULL;

-- General "show me recent findings" support for the operator runbook /
-- diagnostic queries. Covers the case where proposed_at IS NOT NULL too.
CREATE INDEX IF NOT EXISTS persona_test_candidates_last_seen
  ON persona_test_candidates (repo_name, last_seen DESC);

COMMENT ON TABLE persona_test_candidates IS
  'Aggregated low-confidence divergences from persona-test consistency-mode canaries. One row per (repo_name, fingerprint). Occurrences increment on each recurrence within the 7-day rolling window. /ship promotes survivors to Playwright spec stubs.';
COMMENT ON COLUMN persona_test_candidates.fingerprint IS
  'sha256(canary_name + surfaceId + engineField + scope + key). Same shape as the per-adopter .persona-test/baseline.json so candidates and baseline entries share a key space.';
COMMENT ON COLUMN persona_test_candidates.proposed_at IS
  'NULL until /ship generates a tests/e2e/candidates/<fp>.spec.js.proposed stub; set to NOW() at that point. NULL again is a re-propose path (operator-only, manual UPDATE).';
COMMENT ON COLUMN persona_test_candidates.occurrences IS
  'Count of canary runs that surfaced this fingerprint within the 7-day window. Promotion gate requires >= 3 (configurable via the adopter''s .persona-test/promotion-policy.json).';

-- RLS — server-only table. No anon / authenticated client ever reads this.
-- The CI workflow + /ship script both use the service_role key.
ALTER TABLE persona_test_candidates ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies for anon / authenticated — default-deny.

COMMIT;
