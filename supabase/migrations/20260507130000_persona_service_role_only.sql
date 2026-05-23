-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Persona-test → service-role only (closes sensitive_columns_exposed)      ║
-- ║                                                                           ║
-- ║  Phase 2 of the persona-table hardening. The 20260507120000 migration    ║
-- ║  enabled RLS + kept anon-read for backwards compat with curl readers in  ║
-- ║  /plan, /ship, persona-test references, and learning-store. That left    ║
-- ║  the `sensitive_columns_exposed` advisor unresolved because anon could   ║
-- ║  still read columns containing PII (description, notes, findings,        ║
-- ║  report_md, debrief_md).                                                 ║
-- ║                                                                           ║
-- ║  This migration drops the anon-read policies. All reads now go through   ║
-- ║  scripts/cross-skill.mjs which holds SUPABASE_AUDIT_SERVICE_ROLE_KEY     ║
-- ║  (the persona project shares the audit project URL).                     ║
-- ║                                                                           ║
-- ║  Migrated readers (no longer use anon):                                   ║
-- ║   - skills/plan/SKILL.md (Phase 1 pre-step)                              ║
-- ║   - skills/ship/SKILL.md (Step 0.5a)                                    ║
-- ║   - skills/persona-test/references/{interop,session-history}.md          ║
-- ║   - scripts/learning-store.mjs (getPersonaSupabase now uses service-role)║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- 1. personas — drop the anon-read policy. RLS stays enabled. With no
--    policies covering anon, deny-by-default applies.
DROP POLICY IF EXISTS "Anon read personas" ON personas;

-- 2. persona_test_sessions — same treatment.
DROP POLICY IF EXISTS "Anon read persona_test_sessions" ON persona_test_sessions;

-- Service-role bypasses RLS automatically (per Supabase docs); writers and
-- readers via cross-skill.mjs (which uses service-role) continue to function.
-- Anon can no longer SELECT either table — verify post-apply:
--   curl ... -H "apikey: $ANON" .../rest/v1/personas?limit=1
--   Expected: HTTP 200 with body `[]` (RLS returns empty set, not 401)
--
-- This is the cleanest signal of a properly-locked-down table per Supabase
-- conventions. The advisor uses the same probe and will mark
-- sensitive_columns_exposed as resolved.
