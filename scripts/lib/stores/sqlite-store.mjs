/**
 * @fileoverview SQLite adapter for the audit-loop learning system.
 * Uses better-sqlite3 (sync API, WAL mode) for local cross-repo persistence.
 *
 * Config:
 *   AUDIT_STORE=sqlite
 *   AUDIT_SQLITE_PATH=<path>  (default: ~/.audit-loop/shared.db)
 *   AUDIT_SQLITE_READONLY=1   (opens DB read-only)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSqlAdapter } from './sql/factory.mjs';
import { normalizeSqliteError } from './sql/sql-errors.mjs';
import { expandTemplate } from './sql/sql-dialect.mjs';

/**
 * Create and initialize the SQLite adapter.
 * @param {object} [config]
 * @param {string} [config.path] - DB file path
 * @param {boolean} [config.readonly] - Open read-only
 * @returns {Promise<object>} Adapter conforming to StorageAdapter
 */
export async function createSqliteAdapter(config = {}) {
  // Dynamic import — better-sqlite3 is an optional dependency
  let Database;
  try {
    const mod = await import('better-sqlite3');
    Database = mod.default;
  } catch {
    throw new Error(
      'AUDIT_STORE=sqlite requires better-sqlite3. Run: npm install better-sqlite3'
    );
  }

  const dbPath = config.path
    || process.env.AUDIT_SQLITE_PATH
    || path.join(os.homedir(), '.audit-loop', 'shared.db');
  const readonly = config.readonly || process.env.AUDIT_SQLITE_READONLY === '1';

  if (!readonly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly,
    fileMustExist: readonly,
  });

  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }

  // Build driver
  const driver = {
    dialect: 'sqlite',
    placeholder: (_n) => '?',

    async query(sql, params = []) {
      try {
        const rows = db.prepare(sql).all(...params);
        return { rows };
      } catch (err) {
        throw Object.assign(err, { _normalized: normalizeSqliteError(err) });
      }
    },

    async exec(sql, params = []) {
      try {
        const info = db.prepare(sql).run(...params);
        return { changes: info.changes };
      } catch (err) {
        throw Object.assign(err, { _normalized: normalizeSqliteError(err) });
      }
    },

    async close() {
      db.close();
    },

    normalizeError: normalizeSqliteError,
  };

  // Compose the adapter from shared SQL repos
  const base = await createSqlAdapter(driver, { dialect: 'sqlite' });

  return {
    name: 'sqlite',
    capabilities: {
      debt: true,
      run: true,
      learningState: true,
      globalState: true,
      repo: true,
      scopeIsolation: true,
    },
    init: async () => {
      try {
        // Verify DB is accessible
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
    ...base,
  };
}

export const adapter = {
  name: 'sqlite',
  capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true, scopeIsolation: true },
  // Deferred init — createSqliteAdapter() called by facade on demand
  _factory: createSqliteAdapter,
};
