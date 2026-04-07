/**
 * @fileoverview Phase D — unified debt-memory facade.
 *
 * Presents a single API to the audit runner and chooses the authoritative
 * source (cloud vs local) at run start. A single audit run never mixes sources
 * (fix R2-H1). Offline runs get reconciled to cloud on next connect (fix R3-H3).
 *
 * Storage precedence:
 *   1. Cloud — when isCloudEnabled() && repoId resolved → primary
 *   2. Local — otherwise, or on cloud failure → .audit/local/debt-events.jsonl
 *
 * The committed debt ledger at .audit/tech-debt.json is the durable,
 * human-approved state. It's mirrored to the cloud debt_entries table when
 * cloud is available, but the committed JSON remains the source of truth for
 * "what debt exists" (cloud may be behind after offline work).
 *
 * Events are the fast-changing, per-run telemetry. Stored in whichever source
 * the run picked.
 *
 * @module scripts/lib/debt-memory
 */

import fs from 'node:fs';
import {
  DEFAULT_DEBT_LEDGER_PATH, readDebtLedger, writeDebtEntries, removeDebtEntry,
  mergeLedgers,
} from './debt-ledger.mjs';
import {
  DEFAULT_DEBT_EVENTS_PATH, appendDebtEventsLocal, readDebtEventsLocal,
  deriveMetricsFromEvents,
} from './debt-events.mjs';
import {
  isCloudEnabled, upsertDebtEntries, removeDebtEntryCloud,
  appendDebtEventsCloud, readDebtEventsCloud,
} from '../learning-store.mjs';

/**
 * The authoritative source for this run's debt events.
 * One source per run — never mixed.
 */
export const EventSource = Object.freeze({
  CLOUD: 'cloud',
  LOCAL: 'local',
  DISABLED: 'disabled',
});

// ── Source selection ────────────────────────────────────────────────────────

/**
 * Pick the authoritative debt-event source for this run.
 * Never throws; logs the choice to stderr for auditability.
 *
 * @param {object} opts
 * @param {boolean} [opts.noDebtLedger=false] - Hard opt-out
 * @param {boolean} [opts.readOnly=false] - Block all event writes
 * @param {string|null} [opts.repoId=null] - Cloud repo UUID (null = no cloud)
 * @returns {{ source: string, canWrite: boolean, repoId: string|null }}
 */
export function selectEventSource({ noDebtLedger = false, readOnly = false, repoId = null } = {}) {
  if (noDebtLedger) {
    process.stderr.write('  [debt] --no-debt-ledger → disabled\n');
    return { source: EventSource.DISABLED, canWrite: false, repoId: null };
  }
  if (isCloudEnabled() && repoId) {
    process.stderr.write(`  [debt] event source: cloud (repo_id=${repoId.slice(0, 8)}…)\n`);
    return { source: EventSource.CLOUD, canWrite: !readOnly, repoId };
  }
  process.stderr.write('  [debt] event source: local (.audit/local/debt-events.jsonl)\n');
  return { source: EventSource.LOCAL, canWrite: !readOnly, repoId: null };
}

// ── Read: hydrated debt ledger ──────────────────────────────────────────────

/**
 * Load the debt ledger, hydrated with event-derived fields from the selected source.
 *
 * @param {object} context - from selectEventSource()
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {Promise<{ version: 1, entries: object[], eventSource: string }>}
 */
export async function loadDebtLedger(context, {
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
  eventsPath = DEFAULT_DEBT_EVENTS_PATH,
} = {}) {
  if (context.source === EventSource.DISABLED) {
    return { version: 1, entries: [], eventSource: EventSource.DISABLED };
  }

  let events = [];
  if (context.source === EventSource.CLOUD) {
    events = await readDebtEventsCloud(context.repoId);
  } else {
    events = readDebtEventsLocal(eventsPath);
  }

  const ledger = readDebtLedger({ ledgerPath, events });
  return { ...ledger, eventSource: context.source };
}

// ── Write: events ───────────────────────────────────────────────────────────

/**
 * Append events to the authoritative source. Emits one 'surfaced' event per
 * (topicId, runId) combination (fix M1) — callers should dedupe before calling.
 *
 * @param {object} context - from selectEventSource()
 * @param {object[]} events - DebtEvent-shaped
 * @param {object} [opts]
 * @returns {Promise<{ written: number, source: string }>}
 */
export async function appendEvents(context, events, { eventsPath = DEFAULT_DEBT_EVENTS_PATH } = {}) {
  if (!context.canWrite || !Array.isArray(events) || events.length === 0) {
    return { written: 0, source: context.source };
  }
  if (context.source === EventSource.CLOUD) {
    const r = await appendDebtEventsCloud(context.repoId, events);
    return { written: r.inserted, source: EventSource.CLOUD };
  }
  if (context.source === EventSource.LOCAL) {
    const written = appendDebtEventsLocal(events, eventsPath);
    return { written, source: EventSource.LOCAL };
  }
  return { written: 0, source: EventSource.DISABLED };
}

// ── Write: debt entries (to both committed JSON + cloud mirror) ─────────────

/**
 * Persist a set of debt entries. Always writes to the committed ledger at
 * `.audit/tech-debt.json` under a file lock. When cloud is active, also
 * mirrors to `debt_entries` table (cloud failures don't block local write).
 *
 * @param {object} context - from selectEventSource()
 * @param {object[]} entries - PersistedDebtEntry-shaped
 * @param {object} [opts]
 * @returns {Promise<{ inserted, updated, total, rejected, cloudMirrored }>}
 */
export async function persistDebtEntries(context, entries, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (context.source === EventSource.DISABLED) {
    return { inserted: 0, updated: 0, total: 0, rejected: [], cloudMirrored: false };
  }
  // Always write to committed JSON first (operator's source of truth)
  const local = await writeDebtEntries(entries, { ledgerPath });

  // Mirror to cloud when active — failures logged, never block local write
  let cloudMirrored = false;
  if (context.source === EventSource.CLOUD) {
    const r = await upsertDebtEntries(context.repoId, entries).catch(e => ({ ok: false, error: e.message }));
    cloudMirrored = r.ok;
  }
  return { ...local, cloudMirrored };
}

/**
 * Remove a debt entry from committed JSON + cloud mirror.
 */
export async function removeDebt(context, topicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (context.source === EventSource.DISABLED) return { removedLocal: false, removedCloud: false };
  const removedLocal = await removeDebtEntry(topicId, { ledgerPath });
  let removedCloud = false;
  if (context.source === EventSource.CLOUD) {
    const r = await removeDebtEntryCloud(context.repoId, topicId).catch(() => ({ ok: false }));
    removedCloud = r.ok;
  }
  return { removedLocal, removedCloud };
}

// ── Offline → Cloud reconciliation (fix R3-H3) ──────────────────────────────

const RECONCILED_MARKER_EVENT = 'reconciled';

/**
 * Replay any unreconciled local events to cloud. Idempotent via the cloud
 * UNIQUE constraint — same event inserted twice is silently dropped.
 *
 * After success, appends a `reconciled` marker to the local log so subsequent
 * runs can skip already-reconciled prefix (opportunistic — we also rely on the
 * cloud's idempotent insert).
 *
 * Best-effort only. If the local log is deleted between runs, gap exists.
 *
 * @param {object} context - must have source=CLOUD + repoId
 * @param {object} [opts]
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {Promise<{ reconciled: number, skipped: boolean }>}
 */
export async function reconcileLocalToCloud(context, { eventsPath = DEFAULT_DEBT_EVENTS_PATH } = {}) {
  if (context.source !== EventSource.CLOUD || !context.repoId) {
    return { reconciled: 0, skipped: true };
  }
  if (!fs.existsSync(eventsPath)) {
    return { reconciled: 0, skipped: true };
  }

  const localEvents = readDebtEventsLocal(eventsPath);
  if (localEvents.length === 0) return { reconciled: 0, skipped: true };

  // Find the index after the last 'reconciled' marker — skip events before it
  let startIdx = 0;
  for (let i = localEvents.length - 1; i >= 0; i--) {
    if (localEvents[i].event === RECONCILED_MARKER_EVENT) {
      startIdx = i + 1;
      break;
    }
  }
  const toSync = localEvents.slice(startIdx).filter(e => e.event !== RECONCILED_MARKER_EVENT);
  if (toSync.length === 0) return { reconciled: 0, skipped: true };

  const r = await appendDebtEventsCloud(context.repoId, toSync);
  if (r.error) {
    process.stderr.write(`  [debt] reconcile failed: ${r.error}\n`);
    return { reconciled: 0, skipped: false };
  }

  // Write a reconciled marker to the local log
  appendDebtEventsLocal([{
    ts: new Date().toISOString(),
    runId: `reconcile-${Date.now()}`,
    event: RECONCILED_MARKER_EVENT,
  }], eventsPath);

  process.stderr.write(`  [debt] reconciled ${r.inserted}/${toSync.length} local events to cloud (${toSync.length - r.inserted} were already present)\n`);
  return { reconciled: r.inserted, skipped: false };
}

// ── Derived metrics (convenience re-export) ─────────────────────────────────

export { deriveMetricsFromEvents, mergeLedgers };
