/**
 * @fileoverview Phase D — debt ledger read/write/merge.
 *
 * The debt ledger (`.audit/tech-debt.json`) is committed, human-approved state.
 * Mutations go through a single-writer lock (`proper-lockfile`) with atomic
 * temp-file + rename to protect against concurrent writers (fix H3).
 *
 * Persistence model:
 *  - On-disk: PersistedDebtEntry (no derived fields) via PersistedDebtEntrySchema
 *  - In-memory after readDebtLedger(): HydratedDebtEntry (+ event-derived fields)
 *
 * Reads hydrate entries from event log (local JSONL or cloud — caller decides).
 * Writers NEVER persist derived fields — they come from events at read time.
 *
 * @module scripts/lib/debt-ledger
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFileSync, normalizePath } from './file-io.mjs';
import { PersistedDebtEntrySchema, DebtLedgerSchema } from './schemas.mjs';
import { readDebtEventsLocal, deriveMetricsFromEvents, DEFAULT_DEBT_EVENTS_PATH } from './debt-events.mjs';

export const DEFAULT_DEBT_LEDGER_PATH = '.audit/tech-debt.json';

const LOCK_RETRIES = 5;
const LOCK_STALE_MS = 30_000;

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Read the debt ledger, hydrating entries with event-derived fields.
 * Returns `{ version: 1, entries: [] }` on ENOENT. Throws on corruption (fail-loud).
 *
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @param {object[]|null} [opts.events=null] - Pre-fetched events; if null, reads local log
 * @param {string} [opts.eventsPath=DEFAULT_DEBT_EVENTS_PATH]
 * @returns {{ version: 1, entries: object[] }} Hydrated ledger
 */
export function readDebtLedger({
  ledgerPath = DEFAULT_DEBT_LEDGER_PATH,
  events = null,
  eventsPath = DEFAULT_DEBT_EVENTS_PATH,
} = {}) {
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) {
    return { version: 1, entries: [] };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Debt ledger corrupted at ${absPath}: ${err.message}`);
  }

  // Validate structure before hydration
  if (!raw || !Array.isArray(raw.entries)) {
    throw new Error(`Debt ledger corrupted: missing entries array at ${absPath}`);
  }

  // Hydrate each entry with event-derived metrics
  const eventStream = events ?? readDebtEventsLocal(eventsPath);
  const metrics = deriveMetricsFromEvents(eventStream);

  const hydrated = [];
  for (const entry of raw.entries) {
    const m = metrics.get(entry.topicId) || {
      distinctRunCount: 0,
      occurrences: 0,
      matchCount: 0,
      escalated: false,
    };
    hydrated.push({
      ...entry,
      distinctRunCount: m.distinctRunCount,
      occurrences: m.occurrences,
      matchCount: m.matchCount,
      lastSurfacedRun: m.lastSurfacedRun,
      lastSurfacedAt: m.lastSurfacedAt,
      escalated: m.escalated,
      escalatedAt: m.escalatedAt,
    });
  }

  return { version: 1, entries: hydrated };
}

// ── Write (single-writer, locked) ───────────────────────────────────────────

/**
 * Write or merge entries into the debt ledger under a file lock.
 * On topicId match with an existing entry: updates mutable fields in place
 * (rationale, classification, owner, etc). Does NOT insert duplicates.
 *
 * Invalid entries are returned in `rejected[]` with a per-entry reason,
 * matching Phase B's batchWriteLedger contract. Caller decides whether to
 * proceed or surface the failures.
 *
 * @param {object[]} entries - PersistedDebtEntry-shaped (no derived fields)
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath=DEFAULT_DEBT_LEDGER_PATH]
 * @returns {Promise<{ inserted: number, updated: number, total: number, rejected: Array<{entry, reason}> }>}
 */
export async function writeDebtEntries(entries, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { inserted: 0, updated: 0, total: 0, rejected: [] };
  }

  const absPath = path.resolve(ledgerPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // proper-lockfile requires the locked file to exist.
  if (!fs.existsSync(absPath)) {
    atomicWriteFileSync(absPath, JSON.stringify({ version: 1, entries: [] }, null, 2));
  }

  let release;
  try {
    release = await lockfile.lock(absPath, {
      retries: { retries: LOCK_RETRIES, minTimeout: 100, maxTimeout: 1000 },
      stale: LOCK_STALE_MS,
    });
  } catch (err) {
    throw new Error(
      `Failed to acquire debt-ledger lock at ${absPath}: ${err.message}. ` +
      `Another audit-loop run may be mutating the ledger. ` +
      `If stuck, inspect ${absPath}.lock and remove if clearly stale.`
    );
  }

  try {
    // Read current state under lock
    let current = { version: 1, entries: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      if (raw && Array.isArray(raw.entries)) current = raw;
      else throw new Error('missing entries array');
    } catch (err) {
      throw new Error(`Debt ledger corrupted: ${err.message}`);
    }

    const byTopic = new Map(current.entries.map(e => [e.topicId, e]));
    const rejected = [];
    let inserted = 0, updated = 0;

    for (const entry of entries) {
      const validated = PersistedDebtEntrySchema.safeParse(entry);
      if (!validated.success) {
        rejected.push({ entry, reason: validated.error.message.slice(0, 300) });
        continue;
      }
      const validEntry = validated.data;

      if (byTopic.has(validEntry.topicId)) {
        // Merge: preserve original deferredAt/deferredRun, update mutable fields,
        // union contentAliases.
        const existing = byTopic.get(validEntry.topicId);
        const mergedAliases = Array.from(new Set([
          ...(existing.contentAliases || []),
          ...(validEntry.contentAliases || []),
        ]));
        byTopic.set(validEntry.topicId, {
          ...existing,
          ...validEntry,
          deferredAt: existing.deferredAt,       // immutable
          deferredRun: existing.deferredRun,     // immutable
          contentAliases: mergedAliases,
        });
        updated++;
      } else {
        byTopic.set(validEntry.topicId, validEntry);
        inserted++;
      }
    }

    // Sort by topicId for stable diffs (makes merges localized)
    const sortedEntries = [...byTopic.values()].sort((a, b) => a.topicId.localeCompare(b.topicId));
    const next = {
      version: 1,
      entries: sortedEntries,
      lastUpdated: new Date().toISOString(),
    };
    atomicWriteFileSync(absPath, JSON.stringify(next, null, 2) + '\n');

    return {
      inserted,
      updated,
      total: sortedEntries.length,
      rejected,
    };
  } finally {
    try { await release(); } catch { /* lock already released / stale */ }
  }
}

/**
 * Remove a debt entry (soft-delete not supported — the audit trail lives in
 * the event log). Operates under the same lock.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @returns {Promise<boolean>} true if an entry was removed
 */
export async function removeDebtEntry(topicId, { ledgerPath = DEFAULT_DEBT_LEDGER_PATH } = {}) {
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) return false;

  let release;
  try {
    release = await lockfile.lock(absPath, {
      retries: { retries: LOCK_RETRIES, minTimeout: 100, maxTimeout: 1000 },
      stale: LOCK_STALE_MS,
    });
  } catch (err) {
    throw new Error(`Failed to acquire debt-ledger lock: ${err.message}`);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    if (!raw || !Array.isArray(raw.entries)) return false;
    const before = raw.entries.length;
    const after = raw.entries.filter(e => e.topicId !== topicId);
    if (after.length === before) return false;
    atomicWriteFileSync(absPath, JSON.stringify({
      version: 1,
      entries: after,
      lastUpdated: new Date().toISOString(),
    }, null, 2) + '\n');
    return true;
  } finally {
    try { await release(); } catch { /* ignore */ }
  }
}

// ── Merge (session + debt → suppression input) ─────────────────────────────

/**
 * Merge session and debt ledgers for suppressReRaises() input.
 * On topicId collision, SESSION wins (fix M1) — active R2+ decisions override
 * historical debt state for the duration of the current audit run.
 *
 * Debt entries retain their `source: 'debt'` marker so suppressReRaises()
 * can apply source-aware filtering (fix H2).
 *
 * @param {{entries: object[]}} sessionLedger
 * @param {{entries: object[]}} debtLedger - Hydrated
 * @returns {{version: 1, entries: object[]}}
 */
export function mergeLedgers(sessionLedger, debtLedger) {
  const byTopic = new Map();
  // Debt first, session second → session wins collisions
  for (const e of (debtLedger?.entries || [])) {
    byTopic.set(e.topicId, { ...e, source: 'debt' });
  }
  for (const e of (sessionLedger?.entries || [])) {
    byTopic.set(e.topicId, { ...e, source: 'session' });
  }
  return { version: 1, entries: [...byTopic.values()] };
}

// ── Matching (contentAliases) ───────────────────────────────────────────────

/**
 * Check whether a candidate finding's content hash matches any debt entry's
 * topicId OR contentAliases.
 * @param {string} candidateHash - 8-char hex from semanticId()
 * @param {object[]} debtEntries - Hydrated debt entries
 * @returns {object|null} The matched entry, or null
 */
export function findDebtByAlias(candidateHash, debtEntries) {
  if (!candidateHash) return null;
  for (const e of debtEntries) {
    if (e.topicId === candidateHash) return e;
    if ((e.contentAliases || []).includes(candidateHash)) return e;
  }
  return null;
}
