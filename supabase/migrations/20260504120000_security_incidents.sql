-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Proactive security memory — single-table v1                              ║
-- ║  Plan: docs/plans/security-memory-v1.md (v6 after 3 GPT + 2 Gemini)       ║
-- ║                                                                           ║
-- ║  Markdown source-of-truth (docs/security-strategy.md). This table is      ║
-- ║  the embedding INDEX consulted by /plan Phase 0.5b.                       ║
-- ║                                                                           ║
-- ║  AUTHORIZATION (R1-H1): security incidents are MORE SENSITIVE than other  ║
-- ║  audit-loop tables. No anon SELECT policy; reads + writes both require    ║
-- ║  service_role JWT. The cross-skill bridge holds the service-role key.    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- 1. Enums (no `active` value — false-comfort trap from brainstorm-r2)
DO $$ BEGIN
  CREATE TYPE security_mitigation_kind_t AS ENUM ('semgrep', 'manual', 'file-ref');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE security_status_t AS ENUM (
    'mitigation-passing',
    'mitigation-failing',
    'manual-verification-required',
    'historical'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table
CREATE TABLE IF NOT EXISTS security_incidents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id         TEXT NOT NULL,
  description         TEXT NOT NULL,
  affected_paths      TEXT[] NOT NULL DEFAULT '{}',
  mitigation_ref      TEXT,
  mitigation_kind     security_mitigation_kind_t NOT NULL,
  status              security_status_t NOT NULL DEFAULT 'manual-verification-required',
  lessons_learned     TEXT,
  embedding           VECTOR(768),
  embedding_model     TEXT,
  embedding_dim       INTEGER,
  source_fingerprint  TEXT NOT NULL,
  status_check_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, incident_id)
);

-- 3. R3-H2: bump updated_at on every UPDATE so freshness check works
CREATE OR REPLACE FUNCTION touch_security_incidents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_incidents_touch ON security_incidents;
CREATE TRIGGER trg_security_incidents_touch
  BEFORE UPDATE ON security_incidents
  FOR EACH ROW
  EXECUTE FUNCTION touch_security_incidents_updated_at();

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_security_incidents_repo
  ON security_incidents(repo_id);

-- ivfflat created but not used at v1 scale (R3-M1) — present for v2
-- when incident counts cross >200/repo and we restructure the RPC to
-- use ORDER BY embedding <=> $query LIMIT N form.
CREATE INDEX IF NOT EXISTS idx_security_incidents_vector
  ON security_incidents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
  WHERE embedding IS NOT NULL;

-- 5. RLS — ENABLE but NO anon policy (explicit absence is the boundary).
ALTER TABLE security_incidents ENABLE ROW LEVEL SECURITY;

-- 6. RPC: incident_neighbourhood
--    Returns raw signals + path-overlap-first ordering (R1-M3 + R2-H3).
--    Client (lib/neighbourhood-query.mjs) applies env-tunable weighted
--    composite score and re-sorts.
--    SQL escapes literal % and _ in paths before glob translation (R2-M4).
CREATE OR REPLACE FUNCTION incident_neighbourhood(
  p_repo_id          UUID,
  p_target_paths     TEXT[],
  p_intent_embedding VECTOR(768),
  p_k                INT DEFAULT 3
) RETURNS TABLE (
  incident_id       TEXT,
  description       TEXT,
  affected_paths    TEXT[],
  mitigation_ref    TEXT,
  status            security_status_t,
  lessons_learned   TEXT,
  cosine_score      NUMERIC,
  path_overlap      BOOLEAN,
  mitigation_bonus  NUMERIC,
  recency_decay     NUMERIC
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      si.incident_id,
      si.description,
      si.affected_paths,
      si.mitigation_ref,
      si.status,
      si.lessons_learned,
      (1 - (si.embedding <=> p_intent_embedding))::NUMERIC AS cosine_score,
      EXISTS (
        SELECT 1
          FROM unnest(p_target_paths) AS tp,
               unnest(si.affected_paths) AS ap
         WHERE tp LIKE replace(replace(replace(replace(ap, '\', '\\'), '%', '\%'), '_', '\_'), '*', '%') ESCAPE '\'
            OR ap LIKE replace(replace(replace(replace(tp, '\', '\\'), '%', '\%'), '_', '\_'), '*', '%') ESCAPE '\'
      ) AS path_overlap,
      CASE si.status
        WHEN 'mitigation-passing'           THEN 1.0
        WHEN 'manual-verification-required' THEN 0.5
        WHEN 'mitigation-failing'           THEN 0.0
        WHEN 'historical'                   THEN 0.3
      END::NUMERIC AS mitigation_bonus,
      (1.0 / (1.0 + EXTRACT(epoch FROM (v_now - si.created_at)) / 86400.0 / 180.0))::NUMERIC AS recency_decay
    FROM security_incidents si
    WHERE si.repo_id = p_repo_id
      AND si.embedding IS NOT NULL
      AND si.status <> 'historical'
  )
  SELECT
    s.incident_id, s.description, s.affected_paths,
    s.mitigation_ref, s.status, s.lessons_learned,
    s.cosine_score, s.path_overlap,
    s.mitigation_bonus, s.recency_decay
  FROM scored s
  ORDER BY
    s.path_overlap DESC,
    (s.cosine_score + 0.1 * s.mitigation_bonus) DESC,
    s.incident_id ASC
  LIMIT (3 * p_k);
END;
$$;

-- 7. R2-H1: GRANT/REVOKE come AFTER CREATE FUNCTION.
GRANT EXECUTE ON FUNCTION incident_neighbourhood(UUID, TEXT[], VECTOR(768), INT)
  TO service_role;
REVOKE EXECUTE ON FUNCTION incident_neighbourhood(UUID, TEXT[], VECTOR(768), INT)
  FROM anon, authenticated, public;
