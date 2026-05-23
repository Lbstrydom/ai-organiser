-- Phase B: SonarQube-style classification columns for audit_findings.
-- Additive and idempotent — existing rows remain valid with NULLs, re-runnable.

ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS sonar_type TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_name TEXT;

-- All-or-nothing atomicity: classification fields must all be set OR all NULL.
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_classification_atomic;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_classification_atomic
  CHECK (
    (sonar_type IS NULL AND effort IS NULL AND source_kind IS NULL AND source_name IS NULL)
    OR
    (sonar_type IS NOT NULL AND effort IS NOT NULL AND source_kind IS NOT NULL AND source_name IS NOT NULL)
  );

-- Enum constraints (idempotent via DROP + ADD; ALTER doesn't support IF NOT EXISTS for constraints).
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_sonar_type;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_sonar_type
  CHECK (sonar_type IS NULL OR sonar_type IN ('BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT'));

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_effort;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_effort
  CHECK (effort IS NULL OR effort IN ('TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL'));

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS chk_source_kind;
ALTER TABLE audit_findings
  ADD CONSTRAINT chk_source_kind
  CHECK (source_kind IS NULL OR source_kind IN ('MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER'));

-- Partial indexes to keep queries cheap once classification data starts flowing.
CREATE INDEX IF NOT EXISTS idx_audit_findings_sonar_type
  ON audit_findings(sonar_type) WHERE sonar_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_findings_source_kind
  ON audit_findings(source_kind) WHERE source_kind IS NOT NULL;
