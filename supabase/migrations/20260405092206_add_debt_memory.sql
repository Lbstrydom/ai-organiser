-- Phase D: persistent tech-debt memory (cloud persistence).
-- Additive + idempotent. Safe to re-run.
--
-- Two tables:
--   debt_entries — the canonical debt ledger (mirrors .audit/tech-debt.json)
--   debt_events  — append-only event log (surfaced/reopened/escalated/resolved)
--
-- Occurrences are DERIVED from debt_events, never stored as a counter column,
-- so concurrent runs can insert events independently without racing.

-- ── debt_entries ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS debt_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  topic_id            TEXT NOT NULL,
  semantic_hash       TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  category            TEXT NOT NULL,
  section             TEXT NOT NULL,
  detail_snapshot     TEXT NOT NULL,
  affected_files      JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_principles JSONB NOT NULL DEFAULT '[]'::jsonb,
  pass                TEXT NOT NULL,
  -- Phase B classification:
  sonar_type          TEXT CHECK (sonar_type IS NULL OR sonar_type IN ('BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT')),
  effort              TEXT CHECK (effort IS NULL OR effort IN ('TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL')),
  source_kind         TEXT CHECK (source_kind IS NULL OR source_kind IN ('MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER')),
  source_name         TEXT,
  -- Phase D defer fields:
  deferred_reason     TEXT NOT NULL CHECK (deferred_reason IN (
    'out-of-scope', 'blocked-by', 'deferred-followup',
    'accepted-permanent', 'policy-exception'
  )),
  deferred_at         TIMESTAMPTZ NOT NULL,
  deferred_run        TEXT NOT NULL,
  deferred_rationale  TEXT NOT NULL CHECK (char_length(deferred_rationale) >= 20),
  -- Per-reason conditional fields:
  blocked_by          TEXT,
  followup_pr         TEXT,
  approver            TEXT,
  approved_at         TIMESTAMPTZ,
  policy_ref          TEXT,
  -- Ownership:
  owner               TEXT,
  -- Identity mitigation:
  content_aliases     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Sensitivity:
  sensitive           BOOLEAN NOT NULL DEFAULT false,
  -- Bookkeeping:
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- topic_id unique per repo (prevents duplicate defers of the same topic):
  UNIQUE (repo_id, topic_id)
);

-- Per-reason field enforcement (mirrors Zod superRefine)
ALTER TABLE debt_entries DROP CONSTRAINT IF EXISTS chk_debt_reason_fields;
ALTER TABLE debt_entries ADD CONSTRAINT chk_debt_reason_fields CHECK (
  (deferred_reason = 'out-of-scope') OR
  (deferred_reason = 'blocked-by' AND blocked_by IS NOT NULL) OR
  (deferred_reason = 'deferred-followup' AND followup_pr IS NOT NULL) OR
  (deferred_reason = 'accepted-permanent' AND approver IS NOT NULL AND approved_at IS NOT NULL) OR
  (deferred_reason = 'policy-exception' AND policy_ref IS NOT NULL AND approver IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_debt_entries_repo_topic ON debt_entries(repo_id, topic_id);
CREATE INDEX IF NOT EXISTS idx_debt_entries_deferred_reason ON debt_entries(deferred_reason);
CREATE INDEX IF NOT EXISTS idx_debt_entries_sensitive ON debt_entries(sensitive) WHERE sensitive = true;
CREATE INDEX IF NOT EXISTS idx_debt_entries_owner ON debt_entries(owner) WHERE owner IS NOT NULL;

-- ── debt_events ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS debt_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id               UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  topic_id              TEXT,  -- NULL on 'reconciled' markers
  event                 TEXT NOT NULL CHECK (event IN (
    'deferred', 'surfaced', 'reopened', 'escalated', 'resolved', 'reconciled'
  )),
  run_id                TEXT NOT NULL,
  ts                    TIMESTAMPTZ NOT NULL,
  match_count           INTEGER,
  rationale             TEXT,
  resolution_rationale  TEXT,
  resolved_by           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent event writes: one (repo_id, topic_id, run_id, event) tuple per row.
-- Lets the local→cloud reconciler INSERT ON CONFLICT DO NOTHING.
ALTER TABLE debt_events DROP CONSTRAINT IF EXISTS debt_events_unique_tuple;
ALTER TABLE debt_events ADD CONSTRAINT debt_events_unique_tuple
  UNIQUE (repo_id, topic_id, run_id, event);

CREATE INDEX IF NOT EXISTS idx_debt_events_repo_topic ON debt_events(repo_id, topic_id)
  WHERE topic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_debt_events_run ON debt_events(run_id);
CREATE INDEX IF NOT EXISTS idx_debt_events_event ON debt_events(event);

-- ── RLS (match existing audit_* tables — enabled with permissive anon policy) ─
-- CLI tool is personal / single-user; mirrors the pattern from
-- 20260330065641_fix_rls_for_cli.sql.

ALTER TABLE debt_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_events  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for anon" ON debt_entries;
DROP POLICY IF EXISTS "Allow all for anon" ON debt_events;
CREATE POLICY "Allow all for anon" ON debt_entries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON debt_events  FOR ALL USING (true) WITH CHECK (true);
