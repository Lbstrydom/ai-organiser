-- Refresh provenance — distinguishes "leaf" from "missing data" in the
-- rendered architecture map. Plan §2.6.1 (R1-H2, R2-H1).
--
-- Chain-of-trust rule (set by refresh.mjs):
--   Full refresh           → true (every file re-extracted)
--   Incremental from true  → true (copy-forward + new edges = full coverage)
--   Incremental from false → false (copy-forward of nothing leaves gaps)
--   Incremental from NULL  → false (no prior snapshot)

ALTER TABLE refresh_runs
  ADD COLUMN IF NOT EXISTS import_graph_populated BOOLEAN NOT NULL DEFAULT false;
