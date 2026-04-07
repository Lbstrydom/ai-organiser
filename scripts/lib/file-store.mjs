/**
 * @fileoverview Shared file-store abstraction for all read-modify-write state.
 * MutexFileStore: lock + atomic write for JSON state (bandit, FP tracker, experiments).
 * AppendOnlyStore: atomic append for JSONL files (outcomes, evaluations).
 * @module scripts/lib/file-store
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';

// ── Quarantine ──────────────────────────────────────────────────────────────

/**
 * Quarantine corrupted records to .audit/quarantine/ for manual inspection.
 * Records are never silently discarded.
 */
function _quarantineRecord(data, error, sourcePath) {
  try {
    const quarantineDir = path.join(path.dirname(sourcePath), '..', 'quarantine');
    fs.mkdirSync(quarantineDir, { recursive: true });
    const ts = Date.now();
    const filename = `${path.basename(sourcePath)}.${ts}.json`;
    fs.writeFileSync(path.join(quarantineDir, filename), JSON.stringify({
      source: sourcePath,
      quarantinedAt: new Date(ts).toISOString(),
      error: error?.message || String(error),
      data
    }, null, 2));
    process.stderr.write(`  [store] Quarantined corrupted data from ${sourcePath} to quarantine/${filename}\n`);
  } catch (err) {
    process.stderr.write(`  [store] Quarantine failed: ${err.message}\n`);
  }
}

// ── Lock helpers ────────────────────────────────────────────────────────────

function _acquireLockSync(lockPath, staleLockTimeoutMs) {
  const maxAttempts = 50;
  const retryMs = 100;

  // Ensure lock directory exists
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // O_EXCL: fail if file exists
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check if lock is stale
      try {
        const content = fs.readFileSync(lockPath, 'utf-8');
        const lockTs = parseInt(content.split('\n')[1], 10);
        if (!isNaN(lockTs) && (Date.now() - lockTs) > staleLockTimeoutMs) {
          process.stderr.write(`  [store] Breaking stale lock: ${lockPath}\n`);
          try { fs.unlinkSync(lockPath); } catch { /* race ok */ }
          continue;
        }
      } catch { /* lock file gone — retry */ }

      // Wait and retry
      const start = Date.now();
      while (Date.now() - start < retryMs) { /* spin */ }
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath} after ${maxAttempts} attempts`);
}

function _releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already released */ }
}

/**
 * Acquire/release a file lock for external use (e.g., compaction).
 * Exported for direct lock management without MutexFileStore state writes.
 */
export function acquireLock(lockPath, staleLockTimeoutMs = 60000) {
  _acquireLockSync(lockPath, staleLockTimeoutMs);
}

export function releaseLock(lockPath) {
  _releaseLock(lockPath);
}

// ── Read JSONL ──────────────────────────────────────────────────────────────

/**
 * Read a JSONL file, returning array of parsed objects.
 * Invalid lines are skipped with a warning.
 */
export function readJsonlFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return [];
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').trim().split('\n').filter(Boolean);
    const results = [];
    for (const line of lines) {
      try { results.push(JSON.parse(line)); }
      catch { process.stderr.write(`  [store] Skipping invalid JSONL line in ${path.basename(absPath)}\n`); }
    }
    return results;
  } catch (err) {
    process.stderr.write(`  [store] Failed to read ${absPath}: ${err.message}\n`);
    return [];
  }
}

// ── MutexFileStore ──────────────────────────────────────────────────────────

/**
 * Mutex-guarded, atomic file store for JSON state.
 * All read-modify-write state files go through this class.
 */
export class MutexFileStore {
  /**
   * @param {string} filePath - Path to state file
   * @param {object} options
   * @param {number} [options.staleLockTimeoutMs=60000]
   * @param {import('zod').ZodSchema} [options.schema] - Zod schema for validation
   * @param {string} [options.lockPath] - Explicit lock file path
   * @param {*} [options.defaultState] - Default state when file is missing/corrupted
   */
  constructor(filePath, options = {}) {
    this._filePath = path.resolve(filePath);
    this._lockPath = options.lockPath ?? (this._filePath + '.lock');
    this._staleLockTimeoutMs = options.staleLockTimeoutMs ?? 60000;
    this._schema = options.schema ?? null;
    this._defaultState = options.defaultState ?? {};
  }

  /**
   * Acquire lock, read current state, apply mutator, write atomically, release lock.
   * @param {function} mutator - (currentState) => newState
   * @returns {*} The new state after mutation
   */
  mutate(mutator) {
    _acquireLockSync(this._lockPath, this._staleLockTimeoutMs);
    try {
      const current = this._readSync();
      const next = mutator(current);
      if (this._schema) {
        const result = this._schema.safeParse(next);
        if (!result.success) throw result.error;
      }
      atomicWriteFileSync(this._filePath, JSON.stringify(next, null, 2));
      return next;
    } finally {
      _releaseLock(this._lockPath);
    }
  }

  /**
   * Synchronous read with optional Zod validation (no lock needed for read-only).
   * Corrupted records quarantined.
   */
  load() {
    const data = this._readSync();
    if (this._schema) {
      const result = this._schema.safeParse(data);
      if (!result.success) {
        _quarantineRecord(data, result.error, this._filePath);
        return this._defaultState;
      }
    }
    return data;
  }

  /** Synchronous save with lock + atomic write. */
  save(state) {
    _acquireLockSync(this._lockPath, this._staleLockTimeoutMs);
    try {
      if (this._schema) {
        const result = this._schema.safeParse(state);
        if (!result.success) throw result.error;
      }
      atomicWriteFileSync(this._filePath, JSON.stringify(state, null, 2));
    } finally {
      _releaseLock(this._lockPath);
    }
  }

  _readSync() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf-8');
        try {
          return JSON.parse(raw);
        } catch (parseErr) {
          // Quarantine the raw corrupted content before falling back
          _quarantineRecord(raw, parseErr, this._filePath);
          return this._defaultState;
        }
      }
    } catch { /* fs read error — fall through */ }
    return this._defaultState;
  }
}

// ── AppendOnlyStore ─────────────────────────────────────────────────────────

/**
 * Append-only store for JSONL files (outcomes, evaluations, remediation tasks).
 * Uses the same lock file as compaction to prevent append-during-compact races.
 */
export class AppendOnlyStore {
  /**
   * @param {string} filePath
   * @param {object} options
   * @param {import('zod').ZodSchema} [options.schema] - Optional Zod schema for validation on append
   */
  constructor(filePath, options = {}) {
    this._filePath = path.resolve(filePath);
    this._lockPath = this._filePath + '.lock';
    this._staleLockTimeoutMs = options.staleLockTimeoutMs ?? 60000;
    this._schema = options.schema ?? null;
  }

  /** Append a record. Schema-invalid records are quarantined, not appended. */
  append(record) {
    if (this._schema) {
      const result = this._schema.safeParse(record);
      if (!result.success) {
        _quarantineRecord(record, result.error, this._filePath);
        return;
      }
    }
    _acquireLockSync(this._lockPath, this._staleLockTimeoutMs);
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.appendFileSync(this._filePath, JSON.stringify(record) + '\n');
    } finally {
      _releaseLock(this._lockPath);
    }
  }

  /** Load all records from the JSONL file. */
  loadAll() {
    return readJsonlFile(this._filePath);
  }
}
