-- Stage 1: New tables + additive columns

CREATE TABLE IF NOT EXISTS prompt_revisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  checksum TEXT NOT NULL,
  promoted_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (pass_name, revision_id)
);

CREATE TABLE IF NOT EXISTS prompt_experiments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id TEXT NOT NULL UNIQUE,
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_id TEXT,
  parent_ewr REAL,
  parent_confidence REAL,
  parent_effective_sample_size INT,
  rationale TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'converged', 'promoted', 'killed', 'stale')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  final_ewr REAL,
  final_confidence REAL,
  total_pulls INT DEFAULT 0
);

ALTER TABLE bandit_arms ADD COLUMN IF NOT EXISTS context_bucket TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS principle TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS repo_id UUID DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS file_extension TEXT DEFAULT 'unknown';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'global';

ALTER TABLE prompt_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_experiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_prompt_revisions" ON prompt_revisions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_prompt_experiments" ON prompt_experiments FOR ALL TO anon USING (true) WITH CHECK (true);
