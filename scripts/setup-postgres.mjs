#!/usr/bin/env node
/**
 * @fileoverview Setup CLI for Postgres adapter.
 * Validates connection, creates schema, applies migrations.
 *
 * Usage:
 *   node scripts/setup-postgres.mjs --migrate
 *   AUDIT_POSTGRES_URL=postgres://... node scripts/setup-postgres.mjs --migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandTemplate } from './lib/stores/sql/sql-dialect.mjs';

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

async function main() {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    console.error(`${R}Error${X}: pg not installed. Run: npm install pg`);
    process.exit(1);
  }

  const url = process.env.AUDIT_POSTGRES_URL;
  if (!url) {
    console.error(`${R}Error${X}: AUDIT_POSTGRES_URL is required`);
    process.exit(1);
  }

  const schema = process.env.AUDIT_POSTGRES_SCHEMA || 'audit_loop';
  const sslMode = process.env.AUDIT_POSTGRES_SSL_MODE || 'require';

  console.log(`Postgres Setup`);
  console.log(`  URL: ${url.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  Schema: ${schema}`);

  const Pool = pg.default?.Pool || pg.Pool;
  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode !== 'no-verify' },
  });

  try {
    // Test connection
    await pool.query('SELECT 1');
    console.log(`  ${G}Connected${X}`);

    // Create schema if needed
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    console.log(`  ${G}Schema "${schema}" ready${X}`);

    // Read and apply migrations
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const schemaDir = path.join(thisDir, 'lib', 'stores', 'sql-schema');
    const meta = JSON.parse(fs.readFileSync(path.join(schemaDir, 'meta.json'), 'utf-8'));

    for (const migration of meta.migrations) {
      let sql = fs.readFileSync(path.join(schemaDir, migration), 'utf-8');
      sql = expandTemplate(sql, 'postgres', schema);
      // Postgres needs GENERATED ALWAYS instead of AUTOINCREMENT
      sql = sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY');
      // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
      sql = sql.replace(/INSERT OR IGNORE/g, 'INSERT');
      await pool.query(sql);
      console.log(`  ${G}+${X} ${migration}`);
    }

    console.log(`\n${G}Done${X}: schema version ${meta.schemaVersion}`);
  } catch (err) {
    console.error(`${R}Setup failed${X}: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
