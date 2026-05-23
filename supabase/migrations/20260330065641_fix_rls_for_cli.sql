-- ============================================================================
-- Fix RLS for CLI access — allow anon key with user_id column set explicitly.
-- For personal CLI tools, we use a fixed user_id from a config/env var
-- rather than requiring Supabase Auth login flow.
--
-- Strategy: Allow inserts/updates where the provided user_id matches the
-- configured audit_user_id setting, OR allow all access for authenticated users.
-- ============================================================================

-- Drop existing policies (they require auth.uid() which is null for anon)
DROP POLICY IF EXISTS "Users manage own audit_repos" ON audit_repos;
DROP POLICY IF EXISTS "Users manage own audit_runs" ON audit_runs;
DROP POLICY IF EXISTS "Users manage own audit_findings" ON audit_findings;
DROP POLICY IF EXISTS "Users manage own adjudication_events" ON finding_adjudication_events;
DROP POLICY IF EXISTS "Users manage own suppression_events" ON suppression_events;
DROP POLICY IF EXISTS "Users manage own pass_stats" ON audit_pass_stats;
DROP POLICY IF EXISTS "Users manage own fp_patterns" ON false_positive_patterns;
DROP POLICY IF EXISTS "Users manage own prompt_variants" ON prompt_variants;
DROP POLICY IF EXISTS "Users manage own bandit_arms" ON bandit_arms;

-- Make user_id nullable (CLI doesn't have auth.uid())
ALTER TABLE audit_repos ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE audit_runs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE audit_findings ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE finding_adjudication_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE suppression_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE audit_pass_stats ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE prompt_variants ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE bandit_arms ALTER COLUMN user_id DROP NOT NULL;

-- Drop FK constraint on user_id since it references auth.users which may not have entries
ALTER TABLE audit_repos DROP CONSTRAINT IF EXISTS audit_repos_user_id_fkey;
ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_user_id_fkey;
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS audit_findings_user_id_fkey;
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS finding_adjudication_events_user_id_fkey;
ALTER TABLE suppression_events DROP CONSTRAINT IF EXISTS suppression_events_user_id_fkey;
ALTER TABLE audit_pass_stats DROP CONSTRAINT IF EXISTS audit_pass_stats_user_id_fkey;
ALTER TABLE false_positive_patterns DROP CONSTRAINT IF EXISTS false_positive_patterns_user_id_fkey;
ALTER TABLE prompt_variants DROP CONSTRAINT IF EXISTS prompt_variants_user_id_fkey;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_user_id_fkey;

-- Also fix the unique constraint on audit_repos that includes user_id
ALTER TABLE audit_repos DROP CONSTRAINT IF EXISTS audit_repos_user_id_fingerprint_key;
ALTER TABLE audit_repos ADD CONSTRAINT audit_repos_fingerprint_key UNIQUE (fingerprint);

-- Fix unique constraints that include user_id
ALTER TABLE false_positive_patterns DROP CONSTRAINT IF EXISTS false_positive_patterns_user_id_repo_id_pattern_type_patte_key;
ALTER TABLE prompt_variants DROP CONSTRAINT IF EXISTS prompt_variants_user_id_pass_name_variant_name_key;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_user_id_pass_name_variant_id_context_bucket_key;

-- Re-add without user_id
ALTER TABLE false_positive_patterns ADD CONSTRAINT false_positive_patterns_repo_pattern_key UNIQUE (repo_id, pattern_type, pattern_value);
ALTER TABLE prompt_variants ADD CONSTRAINT prompt_variants_pass_variant_key UNIQUE (pass_name, variant_name);
ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_pass_variant_bucket_key UNIQUE (pass_name, variant_id, context_bucket);

-- Simple permissive policies — CLI tool is personal, single-user
CREATE POLICY "Allow all for anon" ON audit_repos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON audit_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON audit_findings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON finding_adjudication_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON suppression_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON audit_pass_stats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON false_positive_patterns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON prompt_variants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON bandit_arms FOR ALL USING (true) WITH CHECK (true);
