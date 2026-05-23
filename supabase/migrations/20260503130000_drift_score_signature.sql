-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  drift_score v3: signature_hash-based exact duplication                   ║
-- ║                                                                           ║
-- ║  v1 was O(n²) cross-join over embeddings — timed out at >2000 symbols.    ║
-- ║  v2 (20260503120000) tried ANN via ivfflat + LATERAL — still too slow     ║
-- ║  (11s on 837 symbols; the per-row LATERAL re-evaluates 3 joins, defeats   ║
-- ║  the index). Both approaches require materialized per-snapshot indexes    ║
-- ║  to be performant — that's a v2-of-drift concern.                         ║
-- ║                                                                           ║
-- ║  This v3 takes a different read on what "drift" means in practice:        ║
-- ║                                                                           ║
-- ║  Real cross-file duplication overwhelmingly produces IDENTICAL            ║
-- ║  signature_hash values, because:                                          ║
-- ║    1. signature_hash = sha256(symbolName + normalised signature + body)   ║
-- ║    2. Truly duplicate symbols ARE byte-identical or near-identical        ║
-- ║       (people copy-paste before refactoring)                              ║
-- ║    3. Haiku purpose summaries converge on the same wording for true       ║
-- ║       duplicates, which feeds back to embedding clustering anyway         ║
-- ║                                                                           ║
-- ║  Counting cross-file rows that share signature_hash is:                   ║
-- ║    - Exact, not approximate                                               ║
-- ║    - Index-served (btree on signature_hash) → milliseconds                ║
-- ║    - Catches the failure mode users actually care about                   ║
-- ║                                                                           ║
-- ║  Near-duplicates with different signatures (same purpose, different       ║
-- ║  implementation) are out of scope for v1 — they're better surfaced        ║
-- ║  through plan-time `getNeighbourhood` consultation (which already         ║
-- ║  uses ANN per-call).                                                      ║
-- ║                                                                           ║
-- ║  The v2 ANN function (20260503120000) is dropped — superseded.            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- Drop the v2 signature so only one drift_score exists
DROP FUNCTION IF EXISTS drift_score(UUID, UUID, NUMERIC, NUMERIC, INTEGER, INTEGER);

-- Helpful supporting index — speeds the GROUP BY signature_hash, kind below.
-- Partial index: only rows with a non-empty signature_hash count toward drift.
CREATE INDEX IF NOT EXISTS idx_symbol_index_refresh_sighash
  ON symbol_index (refresh_id, signature_hash)
  WHERE signature_hash IS NOT NULL AND signature_hash <> '';

CREATE OR REPLACE FUNCTION drift_score(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_sim_dup     NUMERIC DEFAULT 0.85,   -- kept for backwards-compat; unused in v3
  p_sim_name    NUMERIC DEFAULT 0.90    -- kept for backwards-compat; unused in v3
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
  v_total        INTEGER;
  v_with_hash    INTEGER;
BEGIN
  -- Lightweight snapshot stats so callers can see denominators
  SELECT COUNT(*) INTO v_total
  FROM symbol_index
  WHERE refresh_id = p_refresh_id;

  SELECT COUNT(*) INTO v_with_hash
  FROM symbol_index
  WHERE refresh_id = p_refresh_id
    AND signature_hash IS NOT NULL
    AND signature_hash <> '';

  -- Layering violations (cheap, no embedding work)
  SELECT COUNT(*) INTO v_violations
  FROM symbol_layering_violations
  WHERE refresh_id = p_refresh_id;

  -- Cross-file exact-duplicate pairs.
  --
  -- For each (signature_hash, kind) bucket present in the snapshot, count
  -- how many distinct files contributed a row (call it f). The number of
  -- cross-file pair-of-files for that bucket is f*(f-1)/2 — but we want
  -- pair-of-symbols, not pair-of-files, so it's:
  --
  --     C(file_count, 2) summed over buckets where the bucket spans >1 file.
  --
  -- We collapse symbols-per-file in a bucket to one (DISTINCT file_path)
  -- because two copies of the same function in the same file isn't drift —
  -- it's local duplication and a different concern.
  WITH bucket_files AS (
    SELECT
      si.signature_hash,
      sd.kind,
      COUNT(DISTINCT si.file_path) AS file_count
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    WHERE si.refresh_id = p_refresh_id
      AND si.signature_hash IS NOT NULL
      AND si.signature_hash <> ''
    GROUP BY si.signature_hash, sd.kind
    HAVING COUNT(DISTINCT si.file_path) > 1
  )
  SELECT COALESCE(SUM((file_count * (file_count - 1)) / 2)::INTEGER, 0)
    INTO v_dup_pairs
    FROM bucket_files;

  -- Naming divergence: still a v2 placeholder (would need symbolName +
  -- purpose-similarity scoring across buckets — covered by /explain and
  -- plan-time getNeighbourhood today).
  v_naming_div := 0;

  v_score := COALESCE(v_dup_pairs, 0)::numeric
           + COALESCE(v_violations, 0)::numeric * 2
           + COALESCE(v_naming_div, 0)::numeric;

  RETURN jsonb_build_object(
    'generated_at',         now(),
    'repo_id',              p_repo_id,
    'refresh_id',           p_refresh_id,
    'duplication_pairs',    v_dup_pairs,
    'layering_violations',  v_violations,
    'naming_divergences',   v_naming_div,
    'score',                v_score,
    'algorithm',            'signature-hash-exact-v3',
    'snapshot_stats',       jsonb_build_object(
      'total_symbols',     v_total,
      'with_signature',    v_with_hash
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION drift_score(UUID, UUID, NUMERIC, NUMERIC)
  TO anon, authenticated, service_role;
