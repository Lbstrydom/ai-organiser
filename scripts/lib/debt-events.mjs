/**
 * @fileoverview Phase D — debt event log.
 *
 * Events are high-frequency operational telemetry, NOT committed state.
 * Storage precedence (fix R1-H2):
 *   1. Cloud (Supabase `debt_events` table) — primary when configured + reachable
 *   2. Local `.audit/local/debt-events.jsonl` — fallback when cloud unavailable,
 *      also used for offline workflows
 *
 * A single audit run picks exactly ONE authoritative source at start (fix R2-H1).
 * Offline runs can later be reconciled to cloud (fix R3-H3).
 *
 * Occurrences are DERIVED from events — never stored in the ledger itself (fix H3).
 *
 * @module scripts/lib/debt-events
 */

import fs from 'node:fs';
import path from 'node:path';
import { DebtEventSchema } from './schemas.mjs';

export const DEFAULT_DEBT_EVENTS_PATH = '.audit/local/debt-events.jsonl';

// ── Local JSONL append ──────────────────────────────────────────────────────

/**
 * Append events to the local JSONL log. Line-oriented, atomic per-line via O_APPEND.
 * Creates parent directory if missing.
 *
 * @param {object[]} events - DebtEvent-shaped objects
 * @param {string} [eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {number} Count of events written (invalid ones skipped with stderr warning)
 */
export function appendDebtEventsLocal(events, eventsPath = DEFAULT_DEBT_EVENTS_PATH) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const absPath = path.resolve(eventsPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  let written = 0;
  const lines = [];
  for (const evt of events) {
    const validated = DebtEventSchema.safeParse(evt);
    if (!validated.success) {
      process.stderr.write(`  [debt-events] skipping invalid event: ${validated.error.message.slice(0, 120)}\n`);
      continue;
    }
    lines.push(JSON.stringify(validated.data));
    written++;
  }
  if (lines.length === 0) return 0;

  // O_APPEND guarantees atomic per-line append on POSIX and Windows for lines
  // under PIPE_BUF (4KB). Event lines are well below that ceiling.
  fs.appendFileSync(absPath, lines.join('\n') + '\n', { encoding: 'utf-8', flag: 'a' });
  return written;
}

// ── Local JSONL replay ──────────────────────────────────────────────────────

/**
 * Read all events from the local JSONL log. Skips malformed lines with a warning.
 * @param {string} [eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {object[]} DebtEvent[]
 */
export function readDebtEventsLocal(eventsPath = DEFAULT_DEBT_EVENTS_PATH) {
  const absPath = path.resolve(eventsPath);
  if (!fs.existsSync(absPath)) return [];

  const raw = fs.readFileSync(absPath, 'utf-8');
  const events = [];
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  let skipped = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const validated = DebtEventSchema.safeParse(parsed);
      if (validated.success) events.push(validated.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    process.stderr.write(`  [debt-events] local log: ${skipped} malformed line(s) skipped\n`);
  }
  return events;
}

// ── Per-topicId metric derivation ───────────────────────────────────────────

/**
 * Derive per-topicId metrics from an event stream.
 *
 * distinctRunCount: unique runId count across 'surfaced' events (fix M1 — the
 *   semantically meaningful recurrence metric)
 * matchCount: total matches across all 'surfaced' events (sum of matchCount
 *   fields, or count of events if missing)
 * lastSurfacedRun/At: most recent 'surfaced' event's runId + timestamp
 * escalated: most recent 'escalated' event without a subsequent 'resolved'
 *
 * 'resolved' events reset all counters (the entry's history is closed).
 * 'reopened' events are NOT counted in recurrence (they're not suppressions).
 *
 * @param {object[]} events - Chronologically-ordered DebtEvent stream
 * @returns {Map<string, object>} topicId → { distinctRunCount, occurrences, matchCount, lastSurfacedRun, lastSurfacedAt, escalated, escalatedAt }
 */
export function deriveMetricsFromEvents(events) {
  const metrics = new Map();
  // Sort by timestamp to handle out-of-order cloud reads:
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const evt of sorted) {
    if (evt.event === 'reconciled') continue;
    if (!evt.topicId) continue;
    let m = metrics.get(evt.topicId);
    if (!m) {
      m = {
        distinctRunCount: 0,
        matchCount: 0,
        lastSurfacedRun: undefined,
        lastSurfacedAt: undefined,
        escalated: false,
        escalatedAt: undefined,
        _surfacedRuns: new Set(),
      };
      metrics.set(evt.topicId, m);
    }
    switch (evt.event) {
      case 'surfaced':
        if (!m._surfacedRuns.has(evt.runId)) {
          m._surfacedRuns.add(evt.runId);
          m.distinctRunCount = m._surfacedRuns.size;
        }
        m.matchCount += (evt.matchCount ?? 1);
        m.lastSurfacedRun = evt.runId;
        m.lastSurfacedAt = evt.ts;
        break;
      case 'escalated':
        m.escalated = true;
        m.escalatedAt = evt.ts;
        break;
      case 'resolved':
        // Close history — the entry is gone. Drop metrics.
        metrics.delete(evt.topicId);
        break;
      // 'deferred' and 'reopened' don't affect metrics
    }
  }
  // Clean up internal tracking, expose occurrences alias:
  for (const [, m] of metrics) {
    m.occurrences = m.distinctRunCount;
    delete m._surfacedRuns;
  }
  return metrics;
}
