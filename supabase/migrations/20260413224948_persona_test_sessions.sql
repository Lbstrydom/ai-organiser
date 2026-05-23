-- Persona Test Session Memory
-- Stores results from each /persona-test run for pattern detection and regression tracking

create table if not exists persona_test_sessions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- Session identity
  session_id    text not null unique,          -- e.g. "persona-test-1744123456"
  persona       text not null,                 -- e.g. "first-time wine enthusiast on mobile"
  url           text not null,                 -- e.g. "https://myapp.railway.app"
  focus         text,                          -- optional focus area

  -- Execution metadata
  browser_tool  text not null,                 -- "BrightData Scraping Browser" | "Playwright MCP" etc.
  steps_taken   integer not null default 0,
  duration_ms   integer,                       -- optional, if tracked

  -- Findings summary
  verdict       text not null                  -- "Ready for users" | "Needs work" | "Blocked"
                check (verdict in ('Ready for users', 'Needs work', 'Blocked')),
  p0_count      integer not null default 0,
  p1_count      integer not null default 0,
  p2_count      integer not null default 0,
  p3_count      integer not null default 0,
  avg_confidence numeric(3,2),                 -- 0.00–1.00

  -- Full structured findings (for pattern analysis)
  findings      jsonb not null default '[]',   -- array of finding objects

  -- Full report text (for display)
  report_md     text                           -- the full PERSONA TEST REPORT markdown block
);

-- Index for querying sessions by URL (regression tracking)
create index persona_test_sessions_url_idx on persona_test_sessions (url);

-- Index for querying sessions by persona
create index persona_test_sessions_persona_idx on persona_test_sessions (persona);

-- Index for recency queries
create index persona_test_sessions_created_at_idx on persona_test_sessions (created_at desc);

-- View: recurring issues across sessions (same URL, same element, appearing 2+ times)
create or replace view recurring_issues as
select
  url,
  f->>'element'  as element,
  f->>'code'     as severity,
  f->>'observed' as observed,
  count(*)       as occurrence_count,
  max(created_at) as last_seen
from persona_test_sessions,
     jsonb_array_elements(findings) as f
where (f->>'confidence')::numeric >= 0.6
group by url, f->>'element', f->>'code', f->>'observed'
having count(*) >= 2
order by occurrence_count desc, last_seen desc;

-- View: unresolved P0s (appeared in 2+ sessions for a URL)
create or replace view persistent_p0s as
select
  url,
  f->>'element'  as element,
  f->>'observed' as observed,
  f->>'fix'      as fix_direction,
  count(*)       as sessions_seen,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from persona_test_sessions,
     jsonb_array_elements(findings) as f
where (f->>'code') = 'P0'
  and (f->>'confidence')::numeric >= 0.7
group by url, f->>'element', f->>'observed', f->>'fix'
having count(*) >= 2
order by sessions_seen desc;