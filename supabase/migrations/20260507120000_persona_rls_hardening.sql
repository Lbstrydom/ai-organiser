-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Persona-test RLS hardening — Supabase advisor fix                        ║
-- ║                                                                           ║
-- ║  Closes two critical advisor issues on project uahjjdelnnpfmaqjrwoz:      ║
-- ║   1. rls_disabled_in_public — `personas` and `persona_test_sessions`     ║
-- ║      were created (in 20260413*.sql) without ENABLE ROW LEVEL SECURITY.  ║
-- ║      Anon clients could read, insert, update, delete every row.          ║
-- ║   2. sensitive_columns_exposed — `description`/`notes`/`findings`/        ║
-- ║      `report_md` columns can hold PII or full UX-test transcripts.       ║
-- ║                                                                           ║
-- ║  This migration: enable RLS + add anon-READ policies to preserve the      ║
-- ║  existing curl-based readers in:                                          ║
-- ║    - skills/persona-test/references/{interop,session-history}.md         ║
-- ║    - skills/plan/SKILL.md (Phase 1 pre-step)                             ║
-- ║    - skills/ship/SKILL.md (Step 0.5a)                                    ║
-- ║    - scripts/learning-store.mjs (recordPersonaTestSession query)         ║
-- ║                                                                           ║
-- ║  Closes #1 (anon writes blocked — service-role still bypasses RLS for    ║
-- ║  the cross-skill writers). Reduces #2 but does not fully eliminate —     ║
-- ║  see Phase 2 follow-up plan in PR description.                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- 1. personas table
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon read personas" ON personas;
CREATE POLICY "Anon read personas"
  ON personas
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- NO anon INSERT/UPDATE/DELETE policies. Service-role bypasses RLS, so
-- writes via cross-skill.mjs (which holds the service-role key) continue
-- to function. Anon writes are now blocked at the policy boundary.

-- 2. persona_test_sessions table
ALTER TABLE persona_test_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon read persona_test_sessions" ON persona_test_sessions;
CREATE POLICY "Anon read persona_test_sessions"
  ON persona_test_sessions
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- NO anon INSERT/UPDATE/DELETE policies (same rationale as personas).

-- ── Phase 2 follow-up (NOT in this migration; tracked separately) ─────────
--
-- The sensitive_columns_exposed advisor flags this table because anon-read
-- still exposes columns that may contain PII or full UX-test transcripts:
--   personas.description, personas.notes
--   persona_test_sessions.findings (jsonb), .report_md, .debrief_md, .url
--
-- To fully close the advisor, choose one of:
--   (a) Replace each anon-read POLICY above with a VIEW that excludes
--       sensitive columns; revoke direct-table SELECT from anon entirely.
--   (b) Migrate readers (skills/persona-test, /plan, /ship, learning-store)
--       to invoke through scripts/cross-skill.mjs (which uses service-role)
--       and remove the anon-read POLICIES.
--
-- (b) is more secure. (a) is less work and preserves existing curls in
-- consumer-repo SKILL.md files. Decision deferred — surfacing in commit.
