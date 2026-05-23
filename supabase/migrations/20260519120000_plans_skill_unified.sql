-- ─────────────────────────────────────────────────────────────────────────
-- Widen plans.skill to accept the unified `/plan` skill.
--
-- The original cross_skill_data_loop migration (20260419120000) constrained
-- plans.skill to ('plan-backend', 'plan-frontend', 'manual', 'other').
-- /plan-backend and /plan-frontend were since unified into a single `/plan`
-- skill, which writes skill='plan' — rejected by the old CHECK constraint.
--
-- Fix: widen the allowlist to include 'plan'. Legacy values are retained so
-- existing rows authored by the old skills remain valid (no data migration).
-- Purely permissive change — nothing that validated before stops validating.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_skill_check;

ALTER TABLE plans ADD CONSTRAINT plans_skill_check
  CHECK (skill IN ('plan', 'plan-backend', 'plan-frontend', 'manual', 'other'));
