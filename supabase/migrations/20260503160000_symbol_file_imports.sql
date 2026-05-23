-- File-level import edges from dependency-cruiser, persisted per snapshot.
-- Plan: docs/plans/arch-memory-planning-anchor.md §2.6.
--
-- KEYED BY importer_path (R1-H1) — edges are owned by the importer side.
-- Copy-forward keys on importer_path so dropped edges from touched files
-- are correctly absent from the new snapshot.

CREATE TABLE IF NOT EXISTS symbol_file_imports (
  refresh_id      UUID NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  importer_path   TEXT NOT NULL,
  imported_path   TEXT NOT NULL,
  UNIQUE (refresh_id, importer_path, imported_path)
);

-- Both ends indexed (R1-H1 + §2.6):
--   imported  → "who imports this file" lookup for renderer
--   importer  → copy-forward key for incremental refresh
CREATE INDEX IF NOT EXISTS idx_sfi_imported
  ON symbol_file_imports(refresh_id, imported_path);
CREATE INDEX IF NOT EXISTS idx_sfi_importer
  ON symbol_file_imports(refresh_id, importer_path);

ALTER TABLE symbol_file_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_symbol_file_imports" ON symbol_file_imports;
CREATE POLICY "anon_read_symbol_file_imports"
  ON symbol_file_imports FOR SELECT USING (true);
