/**
 * @fileoverview Postgres adapter for the audit-loop learning system.
 * Direct pg driver — no Supabase client dependency.
 *
 * Config:
 *   AUDIT_STORE=postgres
 *   AUDIT_POSTGRES_URL=postgres://user:pass@host:5432/dbname (required)
 *   AUDIT_POSTGRES_SSL_MODE=require|disable|no-verify (default: require)
 *   AUDIT_POSTGRES_MAX_CONNS=4 (default)
 *   AUDIT_POSTGRES_SCHEMA=audit_loop (default)
 */
import { createSqlAdapter } from './sql/factory.mjs';
import { normalizePostgresError } from './sql/sql-errors.mjs';

/**
 * Create and initialize the Postgres adapter.
 * @param {object} [config]
 * @returns {Promise<object>} Adapter conforming to StorageAdapter
 */
export async function createPostgresAdapter(config = {}) {
  // Dynamic import — pg is an optional dependency
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      'AUDIT_STORE=postgres requires pg. Run: npm install pg'
    );
  }

  const url = config.url || process.env.AUDIT_POSTGRES_URL;
  if (!url) {
    throw new Error('AUDIT_POSTGRES_URL is required for postgres adapter');
  }

  const sslMode = config.sslMode || process.env.AUDIT_POSTGRES_SSL_MODE || 'require';
  const maxConns = Number(config.maxConns || process.env.AUDIT_POSTGRES_MAX_CONNS || 4);
  const schema = config.schema || process.env.AUDIT_POSTGRES_SCHEMA || 'audit_loop';

  const Pool = pg.default?.Pool || pg.Pool;
  const pool = new Pool({
    connectionString: url,
    max: maxConns,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode !== 'no-verify' },
  });

  // Build driver
  const driver = {
    dialect: 'postgres',
    placeholder: (n) => `$${n}`,

    async query(sql, params = []) {
      try {
        const res = await pool.query(sql, params);
        return { rows: res.rows };
      } catch (err) {
        throw Object.assign(err, { _normalized: normalizePostgresError(err) });
      }
    },

    async exec(sql, params = []) {
      try {
        const res = await pool.query(sql, params);
        return { changes: res.rowCount ?? 0 };
      } catch (err) {
        throw Object.assign(err, { _normalized: normalizePostgresError(err) });
      }
    },

    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query(sql, params) { return { rows: (await client.query(sql, params)).rows }; },
          async exec(sql, params) { return { changes: (await client.query(sql, params)).rowCount ?? 0 }; },
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },

    normalizeError: normalizePostgresError,
  };

  // Compose the adapter from shared SQL repos
  const base = await createSqlAdapter(driver, { dialect: 'postgres', schema });

  return {
    name: 'postgres',
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
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    ...base,
  };
}

export const adapter = {
  name: 'postgres',
  capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true, scopeIsolation: true },
  _factory: createPostgresAdapter,
};
