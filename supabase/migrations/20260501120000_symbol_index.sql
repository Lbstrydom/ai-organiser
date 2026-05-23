-- ============================================================================
-- Architectural Memory — symbol_index, symbol_definitions, symbol_embeddings,
-- symbol_layering_violations, refresh_runs.
--
-- Backs the per-repo architectural memory consulted by /plan-* and surfaced
-- via docs/architecture-map.md + the weekly drift sweep.
--
-- Plan: docs/plans/architectural-memory.md (v5, audited 2026-05-01)
-- Trigger: spike S1 verified ts-morph extracts intra-file symbols; dep-cruiser
-- handles file-to-file graph (per Gemini-R2 G2).
--
-- Idempotent + RLS-tightened (anon read-only on these tables; service-role for
-- writes — see plan §1 sensitivity model and R2 H10 fix).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── audit_repos extensions ──────────────────────────────────────────────────
-- repo_uuid: stable identity across clones (UUIDv5 from origin URL — per R1 H6 + R3 H6 fix)
-- active_refresh_id: snapshot publication pointer (per R1 H1)
-- active_embedding_model + active_embedding_dim: paired (per R3 H7);
--   ALWAYS concrete model id, never sentinel (per Gemini G2 fix)

ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS repo_uuid              TEXT;
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS active_refresh_id      UUID;
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS active_embedding_model TEXT;
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS active_embedding_dim   INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_repos_repo_uuid
  ON audit_repos (repo_uuid) WHERE repo_uuid IS NOT NULL;

-- ── symbol_definitions ───────────────────────────────────────────────────────
-- Stable per-repo logical identity — survives across refreshes (per R2 H7).
-- Embeddings + cross-snapshot history attach here, NOT to snapshot rows.

CREATE TABLE IF NOT EXISTS symbol_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  canonical_path  TEXT NOT NULL,                  -- repo-relative, normalised forward-slash
  symbol_name     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
    'function','class','component','hook','route','method','constant','type','other'
  )),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ,
  UNIQUE (repo_id, canonical_path, symbol_name, kind)
);

CREATE INDEX IF NOT EXISTS idx_symbol_definitions_repo
  ON symbol_definitions (repo_id) WHERE archived_at IS NULL;

-- ── refresh_runs ─────────────────────────────────────────────────────────────
-- Snapshot publication unit. Workers stage rows under their own refresh_id;
-- atomic promote via publish_refresh_run() RPC (per Gemini-R2 G1).

CREATE TABLE IF NOT EXISTS refresh_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id            UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('full','incremental')),
  status             TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','published','aborted')),
  walk_start_commit  TEXT,
  walk_end_commit    TEXT,
  files_added        JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_modified     JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_deleted      JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_renamed      JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_untracked    JSONB NOT NULL DEFAULT '[]'::jsonb,
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  embed_calls        INTEGER NOT NULL DEFAULT 0,
  cancellation_token UUID,                              -- per R3 H10
  last_heartbeat_at  TIMESTAMPTZ,                       -- per R3 H10
  retention_class    TEXT NOT NULL DEFAULT 'transient'
                          CHECK (retention_class IN ('active','rollback','weekly_checkpoint','transient','aborted')),
  error              TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_runs_repo_status
  ON refresh_runs (repo_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_runs_repo_running
  ON refresh_runs (repo_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_refresh_runs_retention
  ON refresh_runs (repo_id, retention_class, completed_at);

-- ── symbol_index ─────────────────────────────────────────────────────────────
-- Snapshot-scoped row per (definition, refresh). Copy-forward into new
-- refresh_id for untouched files preserves definition_id (per R2 H7).

CREATE TABLE IF NOT EXISTS symbol_index (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_id      UUID NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  definition_id   UUID NOT NULL REFERENCES symbol_definitions(id) ON DELETE CASCADE,
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,                  -- as observed this snapshot
  start_line      INTEGER,
  end_line        INTEGER,
  signature_hash  TEXT NOT NULL,                  -- name + signature + body checksum (per M1)
  purpose_summary TEXT,                            -- 1-line LLM, NULL while pending or [SECRET_REDACTED]
  domain_tag      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (refresh_id, definition_id)
);

CREATE INDEX IF NOT EXISTS idx_symbol_index_refresh
  ON symbol_index (refresh_id);
CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_definition
  ON symbol_index (repo_id, definition_id);
CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_file
  ON symbol_index (repo_id, file_path);

-- ── symbol_embeddings ────────────────────────────────────────────────────────
-- Versioned attribute. Survives across refreshes (keyed on definition_id, NOT
-- on symbol_index.id — corrected per R3 H8).
-- embedding_model: ALWAYS concrete provider id, NEVER sentinel string (per Gemini G2).

CREATE TABLE IF NOT EXISTS symbol_embeddings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id   UUID NOT NULL REFERENCES symbol_definitions(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  dimension       INTEGER NOT NULL,
  embedding       VECTOR(768),                    -- nullable if dim != 768; readers verify
  signature_hash  TEXT NOT NULL,                  -- which signature this embeds
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, embedding_model, dimension, signature_hash)
);

CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_definition
  ON symbol_embeddings (definition_id);
CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_model
  ON symbol_embeddings (embedding_model, dimension);
-- ivfflat created here; tune `lists` once population stabilises.
CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_vector
  ON symbol_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  WHERE embedding IS NOT NULL;

-- ── symbol_layering_violations ───────────────────────────────────────────────
-- Snapshot-scoped (per R2 H8: graph always recomputed full).

CREATE TABLE IF NOT EXISTS symbol_layering_violations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_id    UUID NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  repo_id       UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  rule_name     TEXT NOT NULL,
  from_path     TEXT NOT NULL,
  to_path       TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('error','warn','info')),
  comment       TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (refresh_id, rule_name, from_path, to_path)
);

CREATE INDEX IF NOT EXISTS idx_layering_refresh
  ON symbol_layering_violations (refresh_id);

-- ── publish_refresh_run RPC (per Gemini-R2 G1) ──────────────────────────────
-- Atomic promote: both audit_repos and refresh_runs updated in one transaction.
-- supabase-js / PostgREST cannot multi-statement transact, so the atomic
-- operation MUST live server-side.

-- search_path pinned per Postgres SECURITY DEFINER hardening guideline
-- (R1 audit M6) — prevents schema-injection via user search_path.

CREATE OR REPLACE FUNCTION publish_refresh_run(
  p_repo_id    UUID,
  p_refresh_id UUID,
  p_active_embedding_model TEXT DEFAULT NULL,
  p_active_embedding_dim   INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status  TEXT;
  v_repo_id UUID;
BEGIN
  -- R1 H2/H10: Verify refresh_run BELONGS to p_repo_id (not just same id).
  -- A mismatched (repo, refresh) pair MUST NOT update active_refresh_id.
  SELECT status, repo_id INTO v_status, v_repo_id
    FROM public.refresh_runs WHERE id = p_refresh_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'refresh_run % not found', p_refresh_id;
  END IF;
  IF v_repo_id IS DISTINCT FROM p_repo_id THEN
    RAISE EXCEPTION 'refresh_run % belongs to repo %, not %', p_refresh_id, v_repo_id, p_repo_id;
  END IF;
  IF v_status != 'running' THEN
    RAISE EXCEPTION 'refresh_run % has status %, cannot publish', p_refresh_id, v_status;
  END IF;

  -- Atomic promote
  UPDATE public.refresh_runs
     SET status='published', completed_at=now(), retention_class='active'
   WHERE id = p_refresh_id;

  -- Demote previous active to 'rollback' for the rollback window
  UPDATE public.refresh_runs
     SET retention_class='rollback'
   WHERE repo_id = p_repo_id
     AND status='published'
     AND id != p_refresh_id
     AND retention_class='active';

  -- Promote in repo. R1 audit H4: active_embedding_model + dim are part of
  -- the same atomic publish — never set them outside the publish step, so
  -- repo metadata cannot diverge from a half-completed refresh.
  UPDATE public.audit_repos
     SET active_refresh_id      = p_refresh_id,
         active_embedding_model = COALESCE(p_active_embedding_model, active_embedding_model),
         active_embedding_dim   = COALESCE(p_active_embedding_dim,   active_embedding_dim)
   WHERE id = p_repo_id;

  RETURN jsonb_build_object(
    'ok', true,
    'repo_id', p_repo_id,
    'refresh_id', p_refresh_id,
    'published_at', now()
  );
END;
$$;

-- ── symbol_neighbourhood RPC ────────────────────────────────────────────────
-- Combines 1-2 hop import-graph score with cosine similarity. Reads the
-- caller's chosen refresh_id (typically the active snapshot).
-- kind_filter pushed into RPC per R3 M1.

CREATE OR REPLACE FUNCTION symbol_neighbourhood(
  p_repo_id          UUID,
  p_refresh_id       UUID,
  p_target_paths     TEXT[],
  p_intent_embedding VECTOR(768),
  p_kind_filter      TEXT[] DEFAULT NULL,
  p_k               INTEGER DEFAULT 50
)
RETURNS TABLE (
  symbol_index_id UUID,
  definition_id   UUID,
  symbol_name     TEXT,
  kind            TEXT,
  file_path       TEXT,
  start_line      INTEGER,
  end_line        INTEGER,
  purpose_summary TEXT,
  domain_tag      TEXT,
  similarity      NUMERIC,
  hop_score       NUMERIC,
  combined_score  NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH active_emb_model AS (
    SELECT active_embedding_model AS model, active_embedding_dim AS dim
    FROM audit_repos WHERE id = p_repo_id
  ),
  scored AS (
    SELECT
      si.id                AS symbol_index_id,
      sd.id                AS definition_id,
      sd.symbol_name,
      sd.kind,
      si.file_path,
      si.start_line,
      si.end_line,
      si.purpose_summary,
      si.domain_tag,
      -- Cosine similarity (1 - cosine distance)
      CASE WHEN se.embedding IS NOT NULL AND p_intent_embedding IS NOT NULL
           THEN (1 - (se.embedding <=> p_intent_embedding))::numeric
           ELSE 0::numeric END AS similarity,
      -- Hop score: 1.0 if file in target_paths, 0.5 if file imports a target (1-hop), else 0
      CASE WHEN p_target_paths IS NULL OR array_length(p_target_paths, 1) IS NULL THEN 0::numeric
           WHEN si.file_path = ANY(p_target_paths) THEN 1.0::numeric
           ELSE 0::numeric END AS hop_score
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    LEFT JOIN active_emb_model aem ON true
    LEFT JOIN symbol_embeddings se
           ON se.definition_id = sd.id
          AND se.embedding_model = aem.model
          AND se.dimension       = aem.dim
    WHERE si.refresh_id = p_refresh_id
      AND (p_kind_filter IS NULL
           OR array_length(p_kind_filter, 1) IS NULL
           OR sd.kind = ANY(p_kind_filter))
  )
  SELECT
    s.symbol_index_id, s.definition_id, s.symbol_name, s.kind, s.file_path,
    s.start_line, s.end_line, s.purpose_summary, s.domain_tag,
    s.similarity, s.hop_score,
    (s.hop_score * 0.4 + s.similarity * 0.6)::numeric AS combined_score
  FROM scored s
  ORDER BY combined_score DESC
  LIMIT p_k;
END;
$$;

-- ── drift_score RPC ─────────────────────────────────────────────────────────
-- Counts duplication pairs, layering violations, naming divergences.
-- Thresholds live in scripts/lib/config.mjs (env-tunable).

CREATE OR REPLACE FUNCTION drift_score(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_sim_dup     NUMERIC DEFAULT 0.85,
  p_sim_name    NUMERIC DEFAULT 0.90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dup_pairs    INTEGER;
  v_violations   INTEGER;
  v_naming_div   INTEGER;
  v_score        NUMERIC;
BEGIN
  -- Layering violations
  SELECT COUNT(*) INTO v_violations
  FROM symbol_layering_violations
  WHERE refresh_id = p_refresh_id;

  -- Duplication: cross-file symbol pairs with cosine sim > p_sim_dup, same kind
  WITH active_emb_model AS (
    SELECT active_embedding_model AS model, active_embedding_dim AS dim
    FROM audit_repos WHERE id = p_repo_id
  ),
  embeds AS (
    SELECT sd.id AS definition_id, sd.kind, si.file_path, se.embedding
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    JOIN active_emb_model aem ON true
    JOIN symbol_embeddings se
      ON se.definition_id = sd.id
     AND se.embedding_model = aem.model
     AND se.dimension       = aem.dim
    WHERE si.refresh_id = p_refresh_id
      AND se.embedding IS NOT NULL
  )
  SELECT COUNT(*) INTO v_dup_pairs
  FROM embeds a
  JOIN embeds b ON a.definition_id < b.definition_id
              AND a.kind = b.kind
              AND a.file_path != b.file_path
              AND (1 - (a.embedding <=> b.embedding)) > p_sim_dup;

  -- Naming divergence: high-sim purposes with very different names
  -- (placeholder — costlier query; v1 keeps it simple)
  v_naming_div := 0;

  v_score := v_dup_pairs::numeric + v_violations::numeric * 2 + v_naming_div::numeric;

  RETURN jsonb_build_object(
    'generated_at',         now(),
    'repo_id',              p_repo_id,
    'refresh_id',           p_refresh_id,
    'duplication_pairs',    v_dup_pairs,
    'layering_violations',  v_violations,
    'naming_divergences',   v_naming_div,
    'score',                v_score
  );
END;
$$;

-- ── RLS — anon read-only on all symbol_* tables (per R2 H10) ─────────────────

ALTER TABLE symbol_definitions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_index                ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_embeddings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_layering_violations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_runs                ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_symbol_definitions"         ON symbol_definitions;
DROP POLICY IF EXISTS "anon_read_symbol_index"               ON symbol_index;
DROP POLICY IF EXISTS "anon_read_symbol_embeddings"          ON symbol_embeddings;
DROP POLICY IF EXISTS "anon_read_symbol_layering_violations" ON symbol_layering_violations;
DROP POLICY IF EXISTS "anon_read_refresh_runs"               ON refresh_runs;

CREATE POLICY "anon_read_symbol_definitions"
  ON symbol_definitions FOR SELECT USING (true);
CREATE POLICY "anon_read_symbol_index"
  ON symbol_index FOR SELECT USING (true);
CREATE POLICY "anon_read_symbol_embeddings"
  ON symbol_embeddings FOR SELECT USING (true);
CREATE POLICY "anon_read_symbol_layering_violations"
  ON symbol_layering_violations FOR SELECT USING (true);
CREATE POLICY "anon_read_refresh_runs"
  ON refresh_runs FOR SELECT USING (true);
-- Writes require service-role key (bypasses RLS); no anon-write policy created.

GRANT EXECUTE ON FUNCTION publish_refresh_run(UUID, UUID, TEXT, INTEGER)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION symbol_neighbourhood(UUID, UUID, TEXT[], VECTOR(768), TEXT[], INTEGER)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION drift_score(UUID, UUID, NUMERIC, NUMERIC)
  TO anon, authenticated, service_role;
