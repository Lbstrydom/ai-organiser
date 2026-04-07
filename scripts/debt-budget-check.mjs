#!/usr/bin/env node
/**
 * @fileoverview Phase D.5 — per-path debt budget enforcement CLI.
 *
 * Reads budgets from `.audit/tech-debt.json`'s top-level `budgets` field
 * (or a separate policy file via --budgets-file), counts debt entries per
 * pattern, and exits non-zero when any budget is exceeded.
 *
 * Designed for CI: terse output, stable exit codes, JSON mode available.
 *
 * Exit codes (Phase D CLI contract §2.13):
 *   0 — all budgets within limits (or no budgets configured)
 *   1 — operational error (missing/corrupt ledger, bad args)
 *   2 — policy failure (one or more budgets exceeded)
 *
 * Usage:
 *   node scripts/debt-budget-check.mjs                   # read budgets from ledger
 *   node scripts/debt-budget-check.mjs --budgets-file budgets.json
 *   node scripts/debt-budget-check.mjs --json            # machine output
 *   node scripts/debt-budget-check.mjs --ledger .audit/tech-debt.json
 *
 * @module scripts/debt-budget-check
 */

import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import fs from 'node:fs';
import path from 'node:path';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { findBudgetViolations } from './lib/debt-review-helpers.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    budgetsFile: get('--budgets-file') || null,
    jsonMode: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-budget-check.mjs [options]

Check debt-ledger entry counts against per-path budgets. Non-zero exit if
any budget is exceeded.

Options:
  --ledger <path>          Debt ledger (default: .audit/tech-debt.json)
  --budgets-file <path>    Read budgets from external JSON instead of ledger
  --json                   Machine-readable JSON output to stdout
  --help                   Show this message

Budget file format:
  { "scripts/lib/**": 20, "scripts/openai-audit.mjs": 5 }

Exit codes: 0=within-budget, 1=op-error, 2=over-budget
`);
}

function loadBudgets(opts) {
  if (opts.budgetsFile) {
    const resolved = path.resolve(opts.budgetsFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`budgets file not found: ${resolved}`);
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`budgets file must be an object: ${resolved}`);
    }
    return raw;
  }
  // Read budgets from the ledger's top-level `budgets` field
  const resolved = path.resolve(opts.ledgerPath);
  if (!fs.existsSync(resolved)) return {};
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return raw.budgets || {};
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }

  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, events: [] });
  } catch (err) {
    console.error(`Error reading ledger: ${err.message}`);
    process.exit(1);
  }

  let budgets;
  try {
    budgets = loadBudgets(opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const budgetCount = Object.keys(budgets).length;
  if (budgetCount === 0) {
    if (opts.jsonMode) {
      process.stdout.write(JSON.stringify({ ok: true, violations: [], reason: 'no-budgets-configured' }) + '\n');
    } else {
      process.stdout.write('✓ No budgets configured — nothing to check.\n');
    }
    process.exit(0);
  }

  const violations = findBudgetViolations(ledger.entries, budgets);

  if (opts.jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: violations.length === 0,
      budgetsChecked: budgetCount,
      entriesChecked: ledger.entries.length,
      violations,
    }) + '\n');
  } else if (violations.length === 0) {
    process.stdout.write(`✓ All ${budgetCount} budget(s) within limits (${ledger.entries.length} entries).\n`);
  } else {
    process.stdout.write(`✗ ${violations.length} budget violation(s):\n`);
    for (const v of violations) {
      const over = v.count - v.budget;
      const type = v.isGlob ? 'glob' : 'exact';
      process.stdout.write(`  ${v.path} (${type}): ${v.count} entries / ${v.budget} budget — OVER by ${over}\n`);
    }
  }

  process.exit(violations.length > 0 ? 2 : 0);
}

main();
