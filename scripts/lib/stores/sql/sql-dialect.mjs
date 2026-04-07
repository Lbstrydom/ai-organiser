/**
 * @fileoverview SQL dialect helpers for SQLite + Postgres.
 * Placeholder generation, identifier quoting, upsert building, template expansion.
 */

const IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Quote a SQL identifier (table/column name) safely.
 * Validates against injection before quoting.
 * @param {string} ident
 * @returns {string}
 */
export function quoteIdent(ident) {
  if (!IDENT_PATTERN.test(ident)) {
    throw new Error(`Invalid SQL identifier: "${ident}"`);
  }
  return `"${ident}"`;
}

/**
 * Generate placeholder for parameterized queries.
 * @param {'sqlite'|'postgres'} dialect
 * @param {number} n - 1-based parameter index
 * @returns {string}
 */
export function placeholder(dialect, n) {
  return dialect === 'postgres' ? `$${n}` : '?';
}

/**
 * Build an upsert SQL statement.
 * Uses INSERT ... ON CONFLICT (...) DO UPDATE SET ... for both dialects.
 * @param {object} options
 * @param {string} options.table
 * @param {string[]} options.columns - All columns being inserted
 * @param {string[]} options.conflictTarget - Columns for ON CONFLICT
 * @param {string[]} options.updateColumns - Columns to update on conflict
 * @param {'sqlite'|'postgres'} options.dialect
 * @param {string} [options.schema] - Schema prefix for Postgres
 * @returns {{ sql: string, paramCount: number }}
 */
export function buildUpsert({ table, columns, conflictTarget, updateColumns, dialect, schema }) {
  const qualifiedTable = schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table);
  const colList = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, i) => placeholder(dialect, i + 1)).join(', ');
  const conflictCols = conflictTarget.map(quoteIdent).join(', ');

  let onConflict;
  if (updateColumns.length === 0) {
    onConflict = 'DO NOTHING';
  } else {
    const updates = updateColumns.map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ');
    onConflict = `DO UPDATE SET ${updates}`;
  }

  const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) ${onConflict}`;
  return { sql, paramCount: columns.length };
}

/**
 * Expand dialect-specific template tokens in SQL.
 * @param {string} sql
 * @param {'sqlite'|'postgres'} dialect
 * @param {string} [schema]
 * @returns {string}
 */
export function expandTemplate(sql, dialect, schema) {
  return sql
    .replace(/\{\{JSONB\}\}/g, dialect === 'postgres' ? 'jsonb' : 'TEXT')
    .replace(/\{\{TIMESTAMPTZ\}\}/g, dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT')
    .replace(/\{\{UUID_PK\}\}/g, dialect === 'postgres' ? 'TEXT PRIMARY KEY' : 'TEXT PRIMARY KEY')
    .replace(/\{\{SCHEMA\}\}/g, schema ? `${quoteIdent(schema)}.` : '');
}

export { IDENT_PATTERN };
