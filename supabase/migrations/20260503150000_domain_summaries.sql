-- Per-domain LLM-generated summaries — repo-scoped, content-aware cache.
-- Plan: docs/plans/arch-memory-planning-anchor.md §2.5 (Gemini-R2-G2 hardened
-- composition_hash to be content-derived, not path-derived).
--
-- Cache invariants (any one mismatch → regenerate):
--   - composition_hash:        sha256(sorted "<def_id>|<sig_hash>" rows in domain)
--   - symbol_count:            ±20% delta tolerated
--   - prompt_template_version: integer constant in summarise-domains.mjs
--   - generated_model:         concrete resolved model ID

CREATE TABLE IF NOT EXISTS domain_summaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  domain_tag      TEXT NOT NULL,
  summary         TEXT NOT NULL,
  composition_hash TEXT NOT NULL,
  symbol_count    INTEGER NOT NULL,
  prompt_template_version INTEGER NOT NULL DEFAULT 1,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_model TEXT NOT NULL,
  UNIQUE (repo_id, domain_tag)
);

CREATE INDEX IF NOT EXISTS idx_domain_summaries_repo
  ON domain_summaries(repo_id);

ALTER TABLE domain_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_domain_summaries" ON domain_summaries;
CREATE POLICY "anon_read_domain_summaries"
  ON domain_summaries FOR SELECT USING (true);

-- Writes via service_role only (no policy needed; bypass RLS).
