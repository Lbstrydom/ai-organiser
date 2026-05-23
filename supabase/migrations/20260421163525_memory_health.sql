-- ============================================================================
-- Memory-health RPC — surfaces signals that would justify adopting a
-- graph-shaped findings memory (pgvector clustering / Leiden communities)
-- vs staying on the current semantic_id + Jaccard suppression.
--
-- Three metrics, one RPC, returns JSON. Thresholds live in the Node script
-- so they can evolve without a migration.
--
-- Uses pg_trgm for fast trigram-Jaccard similarity — not identical to the
-- 0.35 Jaccard threshold used in-code, but a close and cheap proxy.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Helpful index so `similarity(detail_snapshot, ...)` uses GIN.
CREATE INDEX IF NOT EXISTS audit_findings_detail_trgm_idx
  ON audit_findings USING gin (detail_snapshot gin_trgm_ops);

CREATE INDEX IF NOT EXISTS audit_findings_created_at_idx
  ON audit_findings (created_at DESC);

-- ----------------------------------------------------------------------------
-- memory_health_metrics(window_days int)
--
-- Returns JSON:
-- {
--   "generated_at": "...",
--   "window_days": 30,
--   "total_findings_in_window": 123,
--   "fuzzy_reraise": {
--     "new_fingerprints": 80,
--     "fuzzy_matched": 12,
--     "rate": 0.15,
--     "samples": [{"finding_id": "...", "similarity": 0.71, "matched_finding_id": "..."}]
--   },
--   "cluster_density": {
--     "per_repo": [{"repo_id": "...", "repo_name": "...", "open_findings": 42, "similar_pairs": 9}],
--     "median_similar_pairs": 3
--   },
--   "recurrence": {
--     "fixed_findings": 14,
--     "recurred": 2,
--     "rate": 0.14,
--     "samples": [...]
--   }
-- }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION memory_health_metrics(
  window_days INT DEFAULT 30,
  similarity_reraise NUMERIC DEFAULT 0.6,
  similarity_cluster NUMERIC DEFAULT 0.5,
  max_pairs_per_repo INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
  window_start TIMESTAMPTZ := NOW() - (window_days || ' days')::INTERVAL;
  total_in_window INT;

  -- Metric 1: fuzzy re-raise
  new_fp_count INT;
  fuzzy_matched_count INT;
  fuzzy_samples JSONB;

  -- Metric 2: cluster density
  cluster_per_repo JSONB;
  median_pairs NUMERIC;

  -- Metric 3: recurrence
  fixed_count INT;
  recurred_count INT;
  recurrence_samples JSONB;
BEGIN
  SELECT COUNT(*) INTO total_in_window
  FROM audit_findings
  WHERE created_at >= window_start;

  -- -------------------------------------------------------------------
  -- Metric 1: Fuzzy re-raise rate
  --   A "new-fingerprint" finding whose detail is similar to an older
  --   finding (different fingerprint, same repo) — this is a re-raise
  --   that fingerprint-only dedup would miss.
  -- -------------------------------------------------------------------
  WITH recent AS (
    SELECT
      f.id,
      f.finding_fingerprint,
      f.detail_snapshot,
      f.created_at,
      r.repo_id
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    WHERE f.created_at >= window_start
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
  ),
  new_fingerprints AS (
    SELECT rec.*
    FROM recent rec
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_findings prior
      JOIN audit_runs pr ON pr.id = prior.run_id
      WHERE prior.finding_fingerprint = rec.finding_fingerprint
        AND prior.created_at < rec.created_at
        AND pr.repo_id = rec.repo_id
    )
  ),
  fuzzy_matches AS (
    SELECT
      nf.id AS finding_id,
      nf.created_at,
      prior.id AS matched_finding_id,
      similarity(nf.detail_snapshot, prior.detail_snapshot) AS sim
    FROM new_fingerprints nf
    JOIN audit_findings prior ON prior.id != nf.id
      AND prior.finding_fingerprint != nf.finding_fingerprint
      AND prior.detail_snapshot IS NOT NULL
      AND length(prior.detail_snapshot) >= 30
    JOIN audit_runs pr ON pr.id = prior.run_id AND pr.repo_id = nf.repo_id
    WHERE prior.created_at < nf.created_at
      AND prior.created_at >= window_start - INTERVAL '60 days'
      AND similarity(nf.detail_snapshot, prior.detail_snapshot) > similarity_reraise
  ),
  best_match AS (
    SELECT DISTINCT ON (finding_id)
      finding_id, matched_finding_id, sim
    FROM fuzzy_matches
    ORDER BY finding_id, sim DESC
  )
  SELECT
    (SELECT COUNT(*) FROM new_fingerprints),
    (SELECT COUNT(*) FROM best_match),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT finding_id, matched_finding_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_match
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    )
  INTO new_fp_count, fuzzy_matched_count, fuzzy_samples;

  -- -------------------------------------------------------------------
  -- Metric 2: Cluster density — open findings with similar text across
  --   different fingerprints in same repo.
  -- -------------------------------------------------------------------
  WITH open_findings AS (
    SELECT
      f.id,
      f.finding_fingerprint,
      f.detail_snapshot,
      r.repo_id,
      ar.name AS repo_name
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    LEFT JOIN audit_repos ar ON ar.id = r.repo_id
    WHERE f.created_at >= window_start
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
      AND NOT EXISTS (
        SELECT 1 FROM finding_adjudication_events ev
        WHERE ev.finding_id = f.id
          AND (ev.adjudication_outcome = 'dismissed'
               OR ev.remediation_state IN ('fixed', 'verified'))
      )
  ),
  per_repo_pairs AS (
    SELECT
      a.repo_id,
      MAX(a.repo_name) AS repo_name,
      COUNT(DISTINCT a.id) AS open_findings,
      COUNT(*) FILTER (
        WHERE a.id < b.id
          AND a.finding_fingerprint != b.finding_fingerprint
          AND similarity(a.detail_snapshot, b.detail_snapshot) > similarity_cluster
      ) AS similar_pairs
    FROM open_findings a
    JOIN open_findings b ON a.repo_id = b.repo_id
    GROUP BY a.repo_id
  ),
  capped AS (
    SELECT
      repo_id,
      repo_name,
      open_findings,
      LEAST(similar_pairs, max_pairs_per_repo) AS similar_pairs
    FROM per_repo_pairs
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(c.*) ORDER BY c.similar_pairs DESC), '[]'::jsonb),
    COALESCE(
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c.similar_pairs),
      0
    )
  INTO cluster_per_repo, median_pairs
  FROM capped c;

  -- -------------------------------------------------------------------
  -- Metric 3: Fixed-finding recurrence
  --   A finding marked fixed/verified, then a similar finding appears in
  --   the same repo within the window.
  -- -------------------------------------------------------------------
  WITH fixed AS (
    SELECT DISTINCT ON (f.id)
      f.id,
      f.detail_snapshot,
      f.finding_fingerprint,
      r.repo_id,
      ev.created_at AS fixed_at
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    JOIN finding_adjudication_events ev ON ev.finding_id = f.id
    WHERE ev.remediation_state IN ('fixed', 'verified')
      AND ev.created_at >= window_start - INTERVAL '30 days'
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
    ORDER BY f.id, ev.created_at DESC
  ),
  recurred AS (
    SELECT
      fx.id AS fixed_id,
      later.id AS recurred_id,
      similarity(fx.detail_snapshot, later.detail_snapshot) AS sim
    FROM fixed fx
    JOIN audit_findings later ON later.id != fx.id
      AND later.finding_fingerprint != fx.finding_fingerprint
      AND later.detail_snapshot IS NOT NULL
    JOIN audit_runs lr ON lr.id = later.run_id AND lr.repo_id = fx.repo_id
    WHERE later.created_at > fx.fixed_at
      AND later.created_at <= fx.fixed_at + INTERVAL '30 days'
      AND similarity(fx.detail_snapshot, later.detail_snapshot) > similarity_reraise
  ),
  best_recur AS (
    SELECT DISTINCT ON (fixed_id)
      fixed_id, recurred_id, sim
    FROM recurred
    ORDER BY fixed_id, sim DESC
  )
  SELECT
    (SELECT COUNT(*) FROM fixed),
    (SELECT COUNT(*) FROM best_recur),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT fixed_id, recurred_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_recur
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    )
  INTO fixed_count, recurred_count, recurrence_samples;

  -- -------------------------------------------------------------------
  -- Assemble
  -- -------------------------------------------------------------------
  result := jsonb_build_object(
    'generated_at', NOW(),
    'window_days', window_days,
    'total_findings_in_window', total_in_window,
    'fuzzy_reraise', jsonb_build_object(
      'new_fingerprints', new_fp_count,
      'fuzzy_matched', fuzzy_matched_count,
      'rate', CASE WHEN new_fp_count > 0
                   THEN ROUND((fuzzy_matched_count::numeric / new_fp_count), 4)
                   ELSE 0 END,
      'samples', fuzzy_samples
    ),
    'cluster_density', jsonb_build_object(
      'per_repo', cluster_per_repo,
      'median_similar_pairs', median_pairs
    ),
    'recurrence', jsonb_build_object(
      'fixed_findings', fixed_count,
      'recurred', recurred_count,
      'rate', CASE WHEN fixed_count > 0
                   THEN ROUND((recurred_count::numeric / fixed_count), 4)
                   ELSE 0 END,
      'samples', recurrence_samples
    )
  );

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_health_metrics(INT, NUMERIC, NUMERIC, INT) TO anon, authenticated;
