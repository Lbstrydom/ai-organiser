-- Persona Registry
-- Tracks named personas scoped per app URL.
-- Lets you see all personas for a given app, when they last tested, and their track record.

create table if not exists personas (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Identity
  name            text not null,                  -- short label, e.g. "Pieter — wine enthusiast"
  description     text not null,                  -- full text passed to /persona-test
  app_url         text not null,                  -- base URL, e.g. "https://myapp.railway.app"
  app_name        text,                           -- human label, e.g. "Wine Cellar App"

  -- Backstory / notes (optional)
  notes           text,                           -- demographics, quirks, backstory, what they care about

  -- Running stats (updated after each session)
  test_count      integer not null default 0,
  last_tested_at  timestamptz,
  last_verdict    text
                  check (last_verdict in ('Ready for users', 'Needs work', 'Blocked') or last_verdict is null),
  last_focus      text,                           -- focus area of most recent session

  -- Unique per app
  unique (name, app_url)
);

-- Link sessions back to the persona that ran them
alter table persona_test_sessions
  add column if not exists persona_id uuid references personas(id) on delete set null;

-- Index for per-app persona lookups
create index personas_app_url_idx on personas (app_url);
create index persona_test_sessions_persona_id_idx on persona_test_sessions (persona_id);

-- View: persona dashboard — one row per persona with test history summary
create or replace view persona_dashboard as
select
  p.id,
  p.name,
  p.app_url,
  p.app_name,
  p.description,
  p.notes,
  p.test_count,
  p.last_tested_at,
  p.last_verdict,
  p.last_focus,
  -- Days since last test (null if never tested)
  case
    when p.last_tested_at is null then null
    else extract(day from now() - p.last_tested_at)::integer
  end as days_since_last_test,
  -- Verdict history (last 5 sessions, newest first)
  (
    select jsonb_agg(
      jsonb_build_object(
        'date', s.created_at::date,
        'verdict', s.verdict,
        'focus', s.focus,
        'p0', s.p0_count,
        'p1', s.p1_count
      )
      order by s.created_at desc
    )
    from (
      select * from persona_test_sessions
      where persona_id = p.id
      order by created_at desc
      limit 5
    ) s
  ) as recent_sessions
from personas p
order by p.app_url, p.last_tested_at asc nulls first;  -- untested personas first