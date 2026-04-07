#!/usr/bin/env node
/**
 * @fileoverview Setup CLI for SQLite adapter.
 * Creates ~/.audit-loop/shared.db and applies schema migrations.
 *
 * Usage:
 *   node scripts/setup-sqlite.mjs [--path <db-path>] [--migrate]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandTemplate } from './lib/stores/sql/sql-dialect.mjs';

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

async function main() {
  let Database;
  try {
    const mod = await import('better-sqlite3');
    Database = mod.default;
  } catch {
    console.error(`${R}Error${X}: better-sqlite3 not installed. Run: npm install better-sqlite3`);
    process.exit(1);
  }

  const dbPath = process.argv.includes('--path')
    ? process.argv[process.argv.indexOf('--path') + 1]
    : path.join(os.homedir(), '.audit-loop', 'shared.db');

  console.log(`SQLite Setup: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Read and apply schema files (use fileURLToPath for cross-platform)
  const { fileURLToPath } = await import('node:url');
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaDir = path.join(thisDir, 'lib', 'stores', 'sql-schema');
  const metaPath = path.join(schemaDir, 'meta.json');

  if (!fs.existsSync(metaPath)) {
    console.error(`${R}Error${X}: schema meta.json not found at ${metaPath}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  db.exec('BEGIN');
  try {
    for (const migration of meta.migrations) {
      const sqlPath = path.join(schemaDir, migration);
      let sql = fs.readFileSync(sqlPath, 'utf-8');
      sql = expandTemplate(sql, 'sqlite');
      // SQLite doesn't support AUTOINCREMENT with IF NOT EXISTS in some forms,
      // but CREATE TABLE IF NOT EXISTS works fine
      db.exec(sql);
      console.log(`  ${G}+${X} ${migration}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`${R}Migration failed${X}: ${err.message}`);
    process.exit(1);
  }

  db.close();
  console.log(`\n${G}Done${X}: schema version ${meta.schemaVersion}, ${meta.migrations.length} migrations applied.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
