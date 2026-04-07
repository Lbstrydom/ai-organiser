/**
 * @fileoverview Canonical error normalization for SQL adapters.
 */

/**
 * @typedef {Object} NormalizedStoreError
 * @property {'transient'|'misconfiguration'|'validation'|'integrity'|'capability'|'unknown'} reason
 * @property {boolean} retryable
 * @property {boolean} bufferToOutbox
 * @property {string} operatorHint
 * @property {string} [nativeCode]
 */

/**
 * Normalize a native SQLite error into a canonical error shape.
 * @param {Error} err
 * @param {string} [context]
 * @returns {NormalizedStoreError}
 */
export function normalizeSqliteError(err, context) {
  const code = err.code || '';
  const msg = err.message || '';

  if (code === 'SQLITE_BUSY' || msg.includes('database is locked')) {
    return { reason: 'transient', retryable: true, bufferToOutbox: true, operatorHint: 'DB locked by another process; retrying next run', nativeCode: code };
  }
  if (code === 'SQLITE_READONLY' || msg.includes('readonly')) {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'DB opened read-only; unset AUDIT_SQLITE_READONLY to write', nativeCode: code };
  }
  if (code === 'SQLITE_CANTOPEN' || msg.includes('unable to open')) {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'Cannot open DB; check path + permissions', nativeCode: code };
  }
  if (code === 'SQLITE_CORRUPT') {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'DB file corrupted; restore from backup', nativeCode: code };
  }
  if (code === 'SQLITE_CONSTRAINT' || msg.includes('UNIQUE constraint failed')) {
    return { reason: 'integrity', retryable: false, bufferToOutbox: false, operatorHint: 'Idempotency conflict — safe to ignore on retry', nativeCode: code };
  }

  return { reason: 'unknown', retryable: false, bufferToOutbox: false, operatorHint: `SQLite error: ${msg}`, nativeCode: code };
}

/**
 * Normalize a native Postgres error into a canonical error shape.
 * @param {Error} err
 * @param {string} [context]
 * @returns {NormalizedStoreError}
 */
export function normalizePostgresError(err, context) {
  const code = err.code || '';
  const msg = err.message || '';

  // Connection errors
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('connection terminated')) {
    return { reason: 'transient', retryable: true, bufferToOutbox: true, operatorHint: 'Postgres unreachable; buffering writes', nativeCode: code };
  }

  // Auth error
  if (code === '28P01') {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'Postgres auth failed; check AUDIT_POSTGRES_URL credentials', nativeCode: code };
  }

  // Missing database
  if (code === '3D000') {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'Postgres DB does not exist; create it', nativeCode: code };
  }

  // Missing table
  if (code === '42P01') {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false, operatorHint: 'Run: node scripts/setup-postgres.mjs --migrate', nativeCode: code };
  }

  // Unique violation
  if (code === '23505') {
    return { reason: 'integrity', retryable: false, bufferToOutbox: false, operatorHint: 'Idempotency conflict — safe to ignore on retry', nativeCode: code };
  }

  // Serialization failure
  if (code === '40001') {
    return { reason: 'transient', retryable: true, bufferToOutbox: true, operatorHint: 'Serialization conflict; retrying', nativeCode: code };
  }

  // Statement timeout
  if (code === '57014') {
    return { reason: 'transient', retryable: true, bufferToOutbox: true, operatorHint: 'Query exceeded statement_timeout', nativeCode: code };
  }

  return { reason: 'unknown', retryable: false, bufferToOutbox: false, operatorHint: `Postgres error: ${msg}`, nativeCode: code };
}
