#!/usr/bin/env node
/**
 * @fileoverview Phase D — manual debt-entry resolution CLI.
 *
 * Removes a debt entry from the committed ledger and emits a 'resolved' event
 * to the authoritative event source (cloud or local). Used when an operator
 * confirms the underlying issue has been fixed (typically after a Step 5
 * verification audit surfaces the resolve prompt).
 *
 * Exit codes (matching the Phase D CLI contract):
 *   0 - success
 *   1 - operational error (missing topicId, corrupt ledger, IO failure)
 *   2 - policy failure (entry not found, lock contention)
 *   3 - sensitivity gate (not used here — reserved)
 *
 * Usage:
 *   node scripts/debt-resolve.mjs <topicId> --rationale "<text>" [--run-id <id>]
 *                                          [--ledger <path>] [--events <path>]
 *                                          [--no-cloud]
 *
 * @module scripts/debt-resolve
 */

// Load .env without the banner (keeps CLI stdout clean for JSON output)
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });
import { initLearningStore, isCloudEnabled, upsertRepo } from './learning-store.mjs';
import { selectEventSource, removeDebt, appendEvents } from './lib/debt-memory.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { DEFAULT_DEBT_EVENTS_PATH } from './lib/debt-events.mjs';
import { generateRepoProfile } from './lib/context.mjs';
import path from 'node:path';

function parseArgs(argv) {
  const args = argv.slice(2);
  // Positional topicId is the first non-flag token
  const first = args[0];
  const topicId = first && !first.startsWith('--') && !first.startsWith('-') ? first : null;
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    topicId,
    rationale: get('--rationale'),
    runId: get('--run-id') || `resolve-${Date.now()}`,
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    eventsPath: get('--events') || DEFAULT_DEBT_EVENTS_PATH,
    noCloud: args.includes('--no-cloud'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-resolve.mjs <topicId> --rationale "<text>" [options]

Remove a debt entry and log a 'resolved' event.

Required:
  <topicId>              Entry topicId to resolve (8-char hex)
  --rationale "<text>"   Why this was resolved (>= 20 chars)

Options:
  --run-id <id>          Attribution for the event (default: resolve-<timestamp>)
  --ledger <path>        Debt ledger path (default: .audit/tech-debt.json)
  --events <path>        Local event log path (default: .audit/local/debt-events.jsonl)
  --no-cloud             Skip cloud mirror, local-only resolve

Exit codes: 0=ok, 1=op-error, 2=not-found or lock-contention
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || !opts.topicId) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }
  if (!opts.rationale) {
    console.error('Error: --rationale is required');
    printUsage();
    process.exit(1);
  }
  if (opts.rationale.length < 20) {
    console.error(`Error: --rationale must be >= 20 chars (got ${opts.rationale.length})`);
    process.exit(1);
  }

  // Initialize cloud (optional)
  let repoId = null;
  if (!opts.noCloud) {
    await initLearningStore().catch(() => {});
    if (isCloudEnabled()) {
      const profile = generateRepoProfile();
      repoId = await upsertRepo(profile, path.basename(path.resolve('.'))).catch(() => null);
    }
  }

  const ctx = selectEventSource({ repoId });

  // Verify entry exists
  const ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, events: [] });
  const entry = ledger.entries.find(e => e.topicId === opts.topicId);
  if (!entry) {
    console.error(`Error: no debt entry with topicId "${opts.topicId}" in ${opts.ledgerPath}`);
    process.exit(2);
  }

  process.stderr.write(`  [debt-resolve] Resolving ${opts.topicId}: ${entry.category || 'unknown category'}\n`);

  // Emit 'resolved' event BEFORE removing (preserves history if remove fails)
  const eventResult = await appendEvents(ctx, [{
    ts: new Date().toISOString(),
    runId: opts.runId,
    topicId: opts.topicId,
    event: 'resolved',
    resolutionRationale: opts.rationale,
    resolvedBy: opts.runId,
  }], { eventsPath: opts.eventsPath });

  // Remove entry from both local ledger + cloud mirror
  let removed;
  try {
    removed = await removeDebt(ctx, opts.topicId, { ledgerPath: opts.ledgerPath });
  } catch (err) {
    console.error(`Error: failed to remove entry: ${err.message}`);
    if (err.message.includes('lock')) process.exit(2);
    process.exit(1);
  }

  if (!removed.removedLocal) {
    console.error(`Error: entry ${opts.topicId} not removed from local ledger`);
    process.exit(1);
  }

  // Summary
  console.log(JSON.stringify({
    ok: true,
    topicId: opts.topicId,
    removedLocal: removed.removedLocal,
    removedCloud: removed.removedCloud,
    eventWritten: eventResult.written > 0,
    eventSource: eventResult.source,
  }));
  process.stderr.write(`  [debt-resolve] ✓ resolved topicId=${opts.topicId} local=${removed.removedLocal} cloud=${removed.removedCloud}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
