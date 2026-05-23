-- Add persona debrief column to persona_test_sessions
-- The debrief is a first-person qualitative narrative written as the persona,
-- covering emotional journey, priorities, pet peeves, and delights.
-- Serves as the product discovery artefact (vs. report_md which serves developers).

alter table persona_test_sessions
  add column if not exists debrief_md text;  -- full persona debrief narrative (400-700 words)

comment on column persona_test_sessions.debrief_md
  is 'First-person qualitative persona narrative for product discovery. Written as the persona, grounded in session observations.';