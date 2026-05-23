-- Add prompt-prefix cache metrics to audit_runs.
-- Source of data: scripts/openai-audit.mjs:_cacheMetrics field on the merged
-- result, written via recordRunComplete().  Used by
-- scripts/cache-hitrate-check.mjs (--source supabase mode) to drive the
-- AUDIT_CACHE_SEED flip-decision schedule.
--
-- All columns nullable — older runs (pre-2026-05-11 bugfix) will have NULL
-- because the cached_tokens field path was wrong before commit 63912c0.
-- The check script's `--since 2026-05-11` filter already excludes those.

ALTER TABLE audit_runs
  ADD COLUMN IF NOT EXISTS cache_input_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cache_cached_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cache_hit_rate NUMERIC(5, 4)
    CHECK (cache_hit_rate IS NULL OR (cache_hit_rate >= 0 AND cache_hit_rate <= 1)),
  ADD COLUMN IF NOT EXISTS cache_estimated_savings_pct NUMERIC(5, 4)
    CHECK (cache_estimated_savings_pct IS NULL OR (cache_estimated_savings_pct >= 0 AND cache_estimated_savings_pct <= 0.5));

-- Lightweight index for the weekly check query (filters round >= 2 +
-- started_at >= cutoff).  No need for cache-rate-specific index since
-- we expect <100 audit runs/week — table scan is fine.
CREATE INDEX IF NOT EXISTS audit_runs_cache_rate_idx
  ON audit_runs (rounds, created_at)
  WHERE cache_hit_rate IS NOT NULL;

COMMENT ON COLUMN audit_runs.cache_input_tokens IS 'Total input tokens billed across this audit run (sum of all pass calls).';
COMMENT ON COLUMN audit_runs.cache_cached_tokens IS 'Subset of cache_input_tokens that hit OpenAI prefix cache.';
COMMENT ON COLUMN audit_runs.cache_hit_rate IS 'cache_cached_tokens / cache_input_tokens.  0..1.';
COMMENT ON COLUMN audit_runs.cache_estimated_savings_pct IS 'Derived: cache_hit_rate * 0.5 (OpenAI ~50% discount on cached tokens).';
