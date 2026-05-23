-- Insert sentinel repo for global-scope patterns
INSERT INTO audit_repos (id, fingerprint, name, stack)
VALUES ('00000000-0000-0000-0000-000000000000', 'GLOBAL_SENTINEL', 'Global (cross-repo)', '{"type": "sentinel"}')
ON CONFLICT (id) DO NOTHING;

-- Delete NULL-bucket bandit arm duplicates
DELETE FROM bandit_arms WHERE context_bucket IS NULL;

-- Deduplicate FP patterns (NULL-safe)
DELETE FROM false_positive_patterns a USING false_positive_patterns b
WHERE a.repo_id IS NOT DISTINCT FROM b.repo_id
  AND a.pattern_type = b.pattern_type
  AND a.pattern_value = b.pattern_value
  AND a.id < b.id;

-- Backfill repo_id sentinel
UPDATE false_positive_patterns
  SET repo_id = '00000000-0000-0000-0000-000000000000'
  WHERE repo_id IS NULL;

UPDATE false_positive_patterns SET file_extension = 'unknown' WHERE file_extension IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET DEFAULT 'unknown';
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- Backfill structured dimensions from old format
UPDATE false_positive_patterns
  SET category = split_part(pattern_value, '::', 1),
      severity = split_part(pattern_value, '::', 2),
      principle = split_part(pattern_value, '::', 3),
      auto_suppress = true,
      scope = 'global'
  WHERE category IS NULL AND pattern_value IS NOT NULL;

-- Enforce NOT NULL
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET NOT NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN scope SET NOT NULL;
