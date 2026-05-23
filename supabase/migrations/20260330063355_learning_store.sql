-- ============================================================================
-- Audit Loop Learning Store — Phase 3
-- Tracks audit outcomes across repos, IDEs, and audit runs for adaptive learning.
-- ============================================================================

-- Repos we've audited
CREATE TABLE IF NOT EXISTS audit_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  stack JSONB NOT NULL DEFAULT '{}',
  file_breakdown JSONB NOT NULL DEFAULT '{}',
  focus_areas TEXT[] NOT NULL DEFAULT '{}',
  last_audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, fingerprint)
);

-- Individual audit runs
CREATE TABLE IF NOT EXISTS audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  repo_id UUID REFERENCES audit_repos(id),
  plan_file TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('plan', 'code')),
  rounds INTEGER NOT NULL DEFAULT 1,
  total_findings INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  fixed_count INTEGER NOT NULL DEFAULT 0,
  gemini_verdict TEXT CHECK (gemini_verdict IN ('APPROVE', 'CONCERNS', 'REJECT')),
  total_cost_estimate NUMERIC(6,3),
  total_duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-finding granular tracking
CREATE TABLE IF NOT EXISTS audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  run_id UUID NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  finding_fingerprint TEXT NOT NULL,
  pass_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  category TEXT NOT NULL,
  primary_file TEXT,
  detail_snapshot TEXT,
  prompt_variant_id UUID,
  round_raised INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-finding adjudication events
CREATE TABLE IF NOT EXISTS finding_adjudication_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  finding_id UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
  adjudication_outcome TEXT NOT NULL CHECK (adjudication_outcome IN ('dismissed', 'accepted', 'severity_adjusted')),
  remediation_state TEXT NOT NULL CHECK (remediation_state IN ('pending', 'planned', 'fixed', 'verified', 'regressed')),
  ruling TEXT CHECK (ruling IN ('sustain', 'overrule', 'compromise')),
  ruling_rationale TEXT,
  round INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Suppression events
CREATE TABLE IF NOT EXISTS suppression_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  run_id UUID NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  finding_fingerprint TEXT NOT NULL,
  matched_topic_id TEXT,
  match_score NUMERIC(4,3),
  action TEXT NOT NULL CHECK (action IN ('suppressed', 'reopened', 'kept')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-pass effectiveness tracking
CREATE TABLE IF NOT EXISTS audit_pass_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  run_id UUID NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  pass_name TEXT NOT NULL,
  findings_raised INTEGER NOT NULL DEFAULT 0,
  findings_accepted INTEGER NOT NULL DEFAULT 0,
  findings_dismissed INTEGER NOT NULL DEFAULT 0,
  findings_compromised INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  reasoning_effort TEXT,
  prompt_variant_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recurring false positive patterns
CREATE TABLE IF NOT EXISTS false_positive_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  repo_id UUID REFERENCES audit_repos(id),
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('category', 'section', 'principle', 'detail_fragment')),
  pattern_value TEXT NOT NULL,
  dismissal_count INTEGER NOT NULL DEFAULT 1,
  last_dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_suppress BOOLEAN NOT NULL DEFAULT FALSE,
  suppress_threshold INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, repo_id, pattern_type, pattern_value)
);

-- Prompt variants and effectiveness
CREATE TABLE IF NOT EXISTS prompt_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  repo_id UUID REFERENCES audit_repos(id),
  pass_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT,
  total_uses INTEGER NOT NULL DEFAULT 0,
  avg_acceptance_rate NUMERIC(4,3),
  avg_findings_per_use NUMERIC(5,1),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, pass_name, variant_name)
);

-- Bandit state (Thompson Sampling)
CREATE TABLE IF NOT EXISTS bandit_arms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  pass_name TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  alpha NUMERIC(8,2) NOT NULL DEFAULT 1,
  beta NUMERIC(8,2) NOT NULL DEFAULT 1,
  pulls INTEGER NOT NULL DEFAULT 0,
  context_bucket TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, pass_name, variant_id, context_bucket)
);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE audit_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_adjudication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_pass_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE false_positive_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE bandit_arms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own audit_repos" ON audit_repos FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own audit_runs" ON audit_runs FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own audit_findings" ON audit_findings FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own adjudication_events" ON finding_adjudication_events FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own suppression_events" ON suppression_events FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own pass_stats" ON audit_pass_stats FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own fp_patterns" ON false_positive_patterns FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own prompt_variants" ON prompt_variants FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own bandit_arms" ON bandit_arms FOR ALL USING (auth.uid() = user_id);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX idx_audit_runs_repo ON audit_runs(repo_id);
CREATE INDEX idx_audit_runs_user_created ON audit_runs(user_id, created_at DESC);
CREATE INDEX idx_audit_findings_run ON audit_findings(run_id);
CREATE INDEX idx_audit_findings_fingerprint ON audit_findings(finding_fingerprint);
CREATE INDEX idx_adjudication_events_finding ON finding_adjudication_events(finding_id);
CREATE INDEX idx_suppression_events_run ON suppression_events(run_id);
CREATE INDEX idx_pass_stats_run ON audit_pass_stats(run_id);
CREATE INDEX idx_fp_patterns_repo ON false_positive_patterns(repo_id);
CREATE INDEX idx_prompt_variants_pass ON prompt_variants(pass_name, is_active);
CREATE INDEX idx_bandit_arms_pass ON bandit_arms(pass_name, user_id);
