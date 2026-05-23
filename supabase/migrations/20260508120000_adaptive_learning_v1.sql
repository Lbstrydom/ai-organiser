-- Adaptive Learning v1 — Phase 1 (Foundation + Auto-Deferral + Weekly Review)
--
-- Plan: docs/plans/adaptive-learning-phase-1-foundation.md
-- Master plan: docs/plans/adaptive-learning-v1.md
--
-- Schema additions are purely additive (all NULLABLE, no defaults that
-- change existing behavior). RLS is service-role-only on new tables;
-- views use WITH (security_invoker = true) so RLS applies to callers.
-- Stored procs are SECURITY DEFINER with locked search_path; EXECUTE
-- revoked from PUBLIC/anon/authenticated, granted to service_role only.

-- ── 1. audit_runs additions ────────────────────────────────────────────────

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_complexity         jsonb;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS round_converged_after   integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS rigor_pressure_round    integer;

-- ── 2. audit_findings additions ────────────────────────────────────────────

ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS user_action            text
  CHECK (user_action IN ('fix-now','deferred','dismissed','needs_triage','accepted-permanent'));
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS dismiss_reason         text;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fix_commit_sha         text;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS time_to_resolution_ms  bigint;

CREATE INDEX IF NOT EXISTS audit_findings_user_action_idx
  ON audit_findings (user_action) WHERE user_action IS NOT NULL;

-- ── 3. recurring_finding_clusters ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recurring_finding_clusters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id            uuid NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  cluster_hash       text NOT NULL,
  severity_history   text[] NOT NULL DEFAULT '{}',
  first_seen         timestamptz NOT NULL DEFAULT now(),
  last_seen          timestamptz NOT NULL DEFAULT now(),
  occurrence_count   integer NOT NULL DEFAULT 1,
  latest_finding_id  uuid REFERENCES audit_findings(id) ON DELETE SET NULL,
  files_affected     text[] NOT NULL DEFAULT '{}',
  cluster_label      text,
  status             text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','fixed','accepted-debt','escalated')),
  UNIQUE (repo_id, cluster_hash)
);

CREATE INDEX IF NOT EXISTS recurring_clusters_repo_last_seen_idx
  ON recurring_finding_clusters (repo_id, last_seen DESC);

ALTER TABLE recurring_finding_clusters ENABLE ROW LEVEL SECURITY;
-- No policies → anon and authenticated reads return empty; service_role
-- bypasses RLS automatically (Supabase default behavior).

-- ── 4. learning_decisions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS learning_decisions (
  decision_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key   text NOT NULL UNIQUE,
  -- decision_key format:
  --   audit-bound:  '<audit_run_id>:<decision_type>:r<round>:s<sequence>'
  --   off-audit:    '<decision_type>:<external_id>'  (e.g. 'quickfix_hit:<hit_id>')
  audit_run_id   uuid REFERENCES audit_runs(id) ON DELETE CASCADE,
  decision_type  text NOT NULL,
  round          integer,
  sequence       integer,
  external_id    text,
  repo_id        uuid REFERENCES audit_repos(id) ON DELETE CASCADE,
  context        jsonb NOT NULL,
  context_hash   text NOT NULL,
  choice         jsonb NOT NULL,
  outcome        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  outcome_at     timestamptz,
  CONSTRAINT decision_key_audit_or_external CHECK (
    (audit_run_id IS NOT NULL AND round IS NOT NULL AND sequence IS NOT NULL)
    OR (external_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS learning_decisions_type_created_idx
  ON learning_decisions (decision_type, created_at DESC);

CREATE INDEX IF NOT EXISTS learning_decisions_outcome_pending_idx
  ON learning_decisions (decision_type, created_at)
  WHERE outcome IS NULL;

-- Phase 2 hot-path index (created here to keep schema atomic).
-- Lookup pattern: SELECT WHERE decision_type='quickfix_hit' AND repo_id=$1 AND outcome IS NULL.
CREATE INDEX IF NOT EXISTS learning_decisions_quickfix_unresolved_idx
  ON learning_decisions (decision_type, repo_id, created_at)
  WHERE decision_type = 'quickfix_hit' AND outcome IS NULL;

ALTER TABLE learning_decisions ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only.

-- ── 5. Stored procedures (transactional write boundaries) ──────────────────
--
-- Both procs use SECURITY DEFINER with locked search_path.  Idempotency is
-- gated by the `decision_key` existence check at the top of each proc — a
-- replay of the same (audit_run_id, round, sequence) returns immediately
-- without re-bumping cluster occurrence_count or re-updating audit_findings.

CREATE OR REPLACE FUNCTION defer_finding(
  p_finding_id    uuid,
  p_dismiss_reason text,
  p_evidence      jsonb,
  p_cluster_hash  text,
  p_severity      text,
  p_audit_run_id  uuid,
  p_round         integer,
  p_sequence      integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_repo_id       uuid;
  v_files         text[];
  v_decision_key  text;
  v_decision_id   uuid;
BEGIN
  v_decision_key := p_audit_run_id::text || ':auto_deferral:r' || p_round::text || ':s' || p_sequence::text;

  -- Race-safe idempotency (H7 fix): rely on the decision_key UNIQUE
  -- constraint to make the INSERT a single-statement guard.  RETURNING
  -- decision_id distinguishes "newly inserted" from "no-op on conflict".
  -- This replaces the prior IF EXISTS ... THEN INSERT pattern, which had
  -- a check-then-act TOCTOU race under concurrent calls.
  --
  -- Note: the cluster upsert + audit_findings UPDATE only run when the
  -- learning_decisions INSERT actually creates a new row, so a retry of
  -- the same (audit_run_id, round, sequence) does NOT bump occurrence_count
  -- a second time.

  -- audit_findings has no repo_id; derive via audit_runs.  Audit-fix H2:
  -- enforce that the supplied finding belongs to the supplied audit run,
  -- otherwise the proc could be tricked into mutating an unrelated finding
  -- across audit-run boundaries.  Raises EXCEPTION on mismatch (proc never
  -- silently writes the wrong row).
  SELECT ar.repo_id, ARRAY[af.primary_file]
    INTO v_repo_id, v_files
    FROM audit_findings af
    JOIN audit_runs ar ON ar.id = af.run_id
    WHERE af.id = p_finding_id AND af.run_id = p_audit_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'defer_finding: finding % does not belong to audit_run %',
      p_finding_id, p_audit_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Single-statement insert with conflict guard.  decision_id is non-null
  -- only when a new row was created (empty result set on conflict).
  INSERT INTO learning_decisions
    (decision_key, audit_run_id, decision_type, round, sequence, repo_id,
     context, context_hash, choice, outcome, outcome_at)
    VALUES (v_decision_key, p_audit_run_id, 'auto_deferral', p_round, p_sequence, v_repo_id,
      p_evidence, encode(sha256(p_evidence::text::bytea), 'hex'),
      jsonb_build_object('class', p_dismiss_reason),
      jsonb_build_object('finding_id', p_finding_id),
      now())
    ON CONFLICT (decision_key) DO NOTHING
    RETURNING decision_id INTO v_decision_id;

  -- If conflict (replay) — return without repeating side effects.
  IF v_decision_id IS NULL THEN
    RETURN;
  END IF;

  -- First-time insert: apply the audit_findings + cluster mutations.
  UPDATE audit_findings
    SET user_action = 'deferred',
        dismiss_reason = p_dismiss_reason
    WHERE id = p_finding_id;

  INSERT INTO recurring_finding_clusters
    (repo_id, cluster_hash, severity_history, files_affected, latest_finding_id)
    VALUES (v_repo_id, p_cluster_hash, ARRAY[p_severity], v_files, p_finding_id)
    ON CONFLICT (repo_id, cluster_hash) DO UPDATE SET
      occurrence_count = recurring_finding_clusters.occurrence_count + 1,
      last_seen = now(),
      severity_history = array_append(recurring_finding_clusters.severity_history, p_severity),
      files_affected = (
        SELECT array_agg(DISTINCT f)
        FROM unnest(recurring_finding_clusters.files_affected || v_files) AS f
      ),
      latest_finding_id = p_finding_id;
END$$;

CREATE OR REPLACE FUNCTION mark_finding_needs_triage(
  p_finding_id    uuid,
  p_reason        text,
  p_audit_run_id  uuid,
  p_round         integer,
  p_sequence      integer,
  p_evidence      jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_repo_id      uuid;
  v_decision_key text;
  v_decision_id  uuid;
BEGIN
  v_decision_key := p_audit_run_id::text || ':needs_triage_route:r' || p_round::text || ':s' || p_sequence::text;

  -- Audit-fix H2: same cross-context integrity check as defer_finding.
  SELECT ar.repo_id INTO v_repo_id
    FROM audit_findings af
    JOIN audit_runs ar ON ar.id = af.run_id
    WHERE af.id = p_finding_id AND af.run_id = p_audit_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_finding_needs_triage: finding % does not belong to audit_run %',
      p_finding_id, p_audit_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Race-safe idempotency (H7 fix): single-statement INSERT guarded by
  -- the decision_key UNIQUE constraint.  Side effects only fire when a
  -- new row was actually created.
  INSERT INTO learning_decisions
    (decision_key, audit_run_id, decision_type, round, sequence, repo_id,
     context, context_hash, choice, outcome, outcome_at)
    VALUES (v_decision_key, p_audit_run_id, 'needs_triage_route', p_round, p_sequence, v_repo_id,
      p_evidence, encode(sha256(p_evidence::text::bytea), 'hex'),
      jsonb_build_object('reason', p_reason),
      jsonb_build_object('finding_id', p_finding_id),
      now())
    ON CONFLICT (decision_key) DO NOTHING
    RETURNING decision_id INTO v_decision_id;

  IF v_decision_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE audit_findings
    SET user_action = 'needs_triage',
        dismiss_reason = p_reason
    WHERE id = p_finding_id;
END$$;

-- ── 6. Stored procedure privileges ─────────────────────────────────────────
-- SECURITY DEFINER + locked search_path is set above.
-- Default Postgres GRANT EXECUTE TO PUBLIC must be revoked explicitly so
-- anon and authenticated callers cannot invoke these privileged writes.

REVOKE EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, integer, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION defer_finding(uuid, text, jsonb, text, text, uuid, integer, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, integer, integer, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, integer, integer, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, integer, integer, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION mark_finding_needs_triage(uuid, text, uuid, integer, integer, jsonb) TO service_role;

-- ── 7. Views ───────────────────────────────────────────────────────────────
--
-- All views use WITH (security_invoker = true) so RLS policies apply to the
-- caller's role rather than the view-creator's.  Without this, the views
-- would bypass RLS and leak data to anon callers.
--
-- Column references verified against existing schema:
--   audit_findings: id, user_id, run_id, finding_fingerprint, pass_name,
--                   severity, category, primary_file, detail_snapshot, ...
--   audit_runs:     id, repo_id, plan_file, mode, commit_sha, branch, ...
--   audit_repos:    id, name, ...
--   persona_test_sessions: id, repo_name (text), created_at, ...

CREATE OR REPLACE VIEW no_brainer_recommendations
  WITH (security_invoker = true) AS
  SELECT * FROM recurring_finding_clusters
  WHERE occurrence_count >= 3 AND status = 'open'
    AND ('HIGH' = ANY(severity_history)
         OR (occurrence_count >= 5 AND 'MEDIUM' = ANY(severity_history)))
  ORDER BY occurrence_count DESC, last_seen DESC LIMIT 50;

CREATE OR REPLACE VIEW pending_triage_findings
  WITH (security_invoker = true) AS
  SELECT af.id,
         ar.repo_id,
         af.severity,
         af.category       AS title,
         af.detail_snapshot AS body,
         af.dismiss_reason,
         af.primary_file,
         af.created_at,
         ar.commit_sha,
         ar.branch
  FROM audit_findings af
  JOIN audit_runs ar ON ar.id = af.run_id
  WHERE af.user_action = 'needs_triage'
  ORDER BY
    CASE WHEN af.severity = 'HIGH' THEN 0
         WHEN af.severity = 'MEDIUM' THEN 1
         ELSE 2 END,
    af.created_at DESC;

CREATE OR REPLACE VIEW persona_density_per_repo
  WITH (security_invoker = true) AS
  SELECT r.id AS repo_id, r.name AS repo_name,
    COALESCE(
      count(pts.id) FILTER (WHERE pts.created_at > now() - interval '30 days'),
      0
    )::integer AS density_30d
  FROM audit_repos r
  LEFT JOIN persona_test_sessions pts ON pts.repo_name = r.name
  GROUP BY r.id, r.name;

-- ── End of migration ───────────────────────────────────────────────────────
