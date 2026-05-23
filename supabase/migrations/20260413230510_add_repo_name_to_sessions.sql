-- Add repo_name to persona_test_sessions
-- Links persona test sessions to the codebase being tested,
-- enabling cross-reference with audit-loop findings for the same repo.

alter table persona_test_sessions
  add column if not exists repo_name text;  -- e.g. "wine-cellar-app", matches audit_repos.name

comment on column persona_test_sessions.repo_name
  is 'Git repo name — used to cross-reference with audit-loop findings (audit_findings.run_id → audit_repos.name)';

-- Also add to personas table so the roster can auto-detect repo context
alter table personas
  add column if not exists repo_name text;

create index persona_test_sessions_repo_name_idx on persona_test_sessions (repo_name);
create index personas_repo_name_idx on personas (repo_name);