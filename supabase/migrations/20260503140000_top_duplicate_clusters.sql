-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  top_duplicate_clusters RPC — surface what drift_score is counting        ║
-- ║                                                                           ║
-- ║  drift_score returns a single number ("110/20 RED"), but doesn't tell     ║
-- ║  you WHICH symbols are duplicated. This RPC returns the top-N            ║
-- ║  cross-file exact-duplicate clusters by file_count, with the actual file  ║
-- ║  paths so triage is one query away — no client-side join required.        ║
-- ║                                                                           ║
-- ║  Cluster = group of symbols that share (signature_hash, kind) across      ║
-- ║  multiple files in the active snapshot. Symbol bodies are byte-identical  ║
-- ║  within a cluster (signature_hash includes sha256 of body).               ║
-- ║                                                                           ║
-- ║  Output ordering: clusters with the most files first, then by             ║
-- ║  signature_hash for stable ties.                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION top_duplicate_clusters(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_limit       INTEGER DEFAULT 20
)
RETURNS TABLE (
  signature_hash  TEXT,
  kind            TEXT,
  file_count      INTEGER,
  symbol_names    TEXT[],
  file_paths      TEXT[],
  example_purpose TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH bucket AS (
    SELECT
      si.signature_hash,
      sd.kind                                AS kind,
      ARRAY_AGG(DISTINCT sd.symbol_name)     AS symbol_names,
      ARRAY_AGG(DISTINCT si.file_path)       AS file_paths,
      COUNT(DISTINCT si.file_path)::INTEGER  AS file_count,
      (ARRAY_AGG(si.purpose_summary))[1]     AS example_purpose
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    WHERE si.refresh_id      = p_refresh_id
      AND sd.repo_id         = p_repo_id
      AND si.signature_hash IS NOT NULL
      AND si.signature_hash <> ''
    GROUP BY si.signature_hash, sd.kind
    HAVING COUNT(DISTINCT si.file_path) > 1
  )
  SELECT signature_hash, kind, file_count, symbol_names, file_paths, example_purpose
    FROM bucket
    ORDER BY file_count DESC, signature_hash
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION top_duplicate_clusters(UUID, UUID, INTEGER)
  TO anon, authenticated, service_role;
