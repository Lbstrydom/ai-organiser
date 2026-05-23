-- Phase 0D: Close the data loop — add outcome tracking columns
-- Enables predictive audit strategy by making adjudication outcomes queryable.

-- Add adjudication outcome to individual findings (denormalized cache)
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS adjudication_outcome TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS remediation_state TEXT;

-- Mark runs as labeled (has real outcome data, not hardcoded zeros)
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS labeled BOOLEAN DEFAULT false;

-- Store suppression stats per round for observability
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS suppression_stats JSONB;

-- Linter overlap tracking for tool effectiveness analysis
ALTER TABLE audit_pass_stats ADD COLUMN IF NOT EXISTS linter_overlap_count INTEGER DEFAULT 0;
ALTER TABLE audit_pass_stats ADD COLUMN IF NOT EXISTS linter_only_count INTEGER DEFAULT 0;
ALTER TABLE audit_pass_stats ADD COLUMN IF NOT EXISTS gpt_only_count INTEGER DEFAULT 0;

-- Index for querying labeled runs (Phase 1 metrics dashboard)
CREATE INDEX IF NOT EXISTS idx_audit_runs_labeled ON audit_runs (labeled) WHERE labeled = true;

-- Index for querying findings by outcome (Phase 1 precision metrics)
CREATE INDEX IF NOT EXISTS idx_audit_findings_outcome ON audit_findings (adjudication_outcome) WHERE adjudication_outcome IS NOT NULL;
