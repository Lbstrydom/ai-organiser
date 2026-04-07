#!/usr/bin/env node
/**
 * @fileoverview Phase D.7 — backfill historical debt from audit-summary files.
 *
 * Two-phase import (per plan §6 step 15):
 *
 *   1. STAGE: `debt-backfill.mjs --source <glob> --stage <path>`
 *      Parses markdown audit summaries, emits StagingRecord[] with per-field
 *      parseConfidence markers. Staging file is NOT read by normal audits.
 *      Operator reviews + fills in low-confidence fields (affectedFiles,
 *      classification) by editing the JSON.
 *
 *   2. PROMOTE: `debt-backfill.mjs --promote <staging>`
 *      Reads the reviewed staging file and writes approved records into
 *      `.audit/tech-debt.json` via the standard writeDebtEntries() path.
 *      Each record needs an `approved: true` field added by the operator;
 *      unapproved records stay in staging with a rejection log.
 *
 * This keeps the operator-as-approver invariant from D.1/D.2: only human-
 * reviewed records land in the live ledger.
 *
 * Exit codes:
 *   0 — success (staged OR promoted)
 *   1 — operational error (missing source, corrupt staging, IO failure)
 *   2 — policy failure (no approved records, or approved records failed
 *       schema validation — caller should fix staging and retry)
 *
 * @module scripts/debt-backfill
 */

import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import fs from 'node:fs';
import path from 'node:path';
import { parseSummaryFiles } from './lib/backfill-parser.mjs';
import { writeDebtEntries, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';

// ── CLI arg parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    sources: get('--source'),
    stagePath: get('--stage') || '.audit/staging/debt-staging.json',
    promote: get('--promote'),
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    runId: get('--run-id') || `backfill-${Date.now()}`,
    defaultOwner: get('--owner'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-backfill.mjs [mode]

STAGE mode: parse audit summaries → staging JSON (not the live ledger)
  --source <glob-list>     Comma-separated files/globs to parse
  --stage <path>           Staging output (default: .audit/staging/debt-staging.json)

PROMOTE mode: write approved staging records to the live ledger
  --promote <staging-path> Read staging file, promote records with approved:true
  --ledger <path>          Live ledger (default: .audit/tech-debt.json)

Shared:
  --run-id <id>            Attribution (default: backfill-<timestamp>)
  --owner <name>           Default owner for promoted records (if absent)

To review staged records before promoting:
  1. node scripts/debt-backfill.mjs --source "docs/complete/phase-*-audit-summary.md"
  2. Open .audit/staging/debt-staging.json, review each record, set approved:true
  3. Fill in affectedFiles, deferredRationale (≥20 chars) if missing
  4. node scripts/debt-backfill.mjs --promote .audit/staging/debt-staging.json

Exit codes: 0=ok, 1=op-error, 2=policy-failure
`);
}

// ── Glob expansion (simple — comma-separated paths or shell glob) ──────────

function expandSources(sourcesArg) {
  if (!sourcesArg) return [];
  const patterns = sourcesArg.split(',').map(s => s.trim()).filter(Boolean);
  const files = new Set();
  for (const p of patterns) {
    if (p.includes('*')) {
      // Lightweight glob via fs.readdirSync + pattern match
      const dir = path.dirname(p);
      const pattern = path.basename(p);
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
      );
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (regex.test(entry)) files.add(path.join(dir, entry));
        }
      } catch { /* missing dir → skip */ }
    } else {
      files.add(p);
    }
  }
  return [...files];
}

// ── Stage mode ──────────────────────────────────────────────────────────────

function runStage(opts) {
  const sourceFiles = expandSources(opts.sources);
  if (sourceFiles.length === 0) {
    console.error('Error: --source required (comma-separated paths or globs)');
    return 1;
  }

  process.stderr.write(`  [backfill] parsing ${sourceFiles.length} file(s)\n`);
  const { records, perFile } = parseSummaryFiles(sourceFiles);

  for (const [file, info] of Object.entries(perFile)) {
    const diag = info.diagnostics.length ? ` — ${info.diagnostics.join('; ')}` : '';
    process.stderr.write(`    ${path.basename(file)}: ${info.count} records${diag}\n`);
  }

  const stagingPath = path.resolve(opts.stagePath);
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  const staging = {
    version: 1,
    createdAt: new Date().toISOString(),
    runId: opts.runId,
    defaultOwner: opts.defaultOwner || null,
    instructions: 'Review each record, set approved:true, fill in affectedFiles and deferredRationale (>=20 chars). Then: node scripts/debt-backfill.mjs --promote <this-file>',
    records: records.map(r => ({
      ...r,
      approved: false,
      // Operator-fillable fields (pre-populated with best guesses):
      affectedFiles: r.inferredFiles,
      deferredReason: 'out-of-scope',
      deferredRationale: '',   // operator must fill (>=20 chars)
    })),
  };
  fs.writeFileSync(stagingPath, JSON.stringify(staging, null, 2) + '\n', 'utf-8');

  process.stderr.write(`  [backfill] wrote ${records.length} staging record(s) to ${stagingPath}\n`);
  process.stderr.write(`  [backfill] Next: review the file, set approved:true on each record, then:\n`);
  process.stderr.write(`  [backfill]   node scripts/debt-backfill.mjs --promote ${stagingPath}\n`);

  console.log(JSON.stringify({
    ok: true,
    mode: 'stage',
    staged: records.length,
    stagePath: stagingPath,
  }));
  return 0;
}

// ── Promote mode ────────────────────────────────────────────────────────────

async function runPromote(opts) {
  const stagePath = path.resolve(opts.promote);
  if (!fs.existsSync(stagePath)) {
    console.error(`Error: staging file not found: ${stagePath}`);
    return 1;
  }

  let staging;
  try {
    staging = JSON.parse(fs.readFileSync(stagePath, 'utf-8'));
  } catch (err) {
    console.error(`Error: staging file corrupted: ${err.message}`);
    return 1;
  }
  if (!Array.isArray(staging.records)) {
    console.error('Error: staging file has no records[] array');
    return 1;
  }

  const approved = staging.records.filter(r => r.approved === true);
  const unapproved = staging.records.filter(r => r.approved !== true);

  process.stderr.write(`  [backfill] ${approved.length} approved, ${unapproved.length} unapproved\n`);

  if (approved.length === 0) {
    console.error('Error: no records have approved:true — review staging file first');
    return 2;
  }

  // Transform approved staging records → PersistedDebtEntry shape
  const entries = [];
  const rejections = [];
  for (const s of approved) {
    if (!s.deferredRationale || s.deferredRationale.length < 20) {
      rejections.push({ topicId: s.suggestedTopicId, reason: 'deferredRationale must be >=20 chars' });
      continue;
    }
    if (!Array.isArray(s.affectedFiles) || s.affectedFiles.length === 0) {
      rejections.push({ topicId: s.suggestedTopicId, reason: 'affectedFiles required' });
      continue;
    }

    const now = new Date().toISOString();
    entries.push({
      source: 'debt',
      topicId: s.suggestedTopicId,
      semanticHash: s.suggestedTopicId,      // best-effort; aliases can be added later
      severity: s.severity,
      category: `[backfill:${s.phaseTag}/${s.findingId}] ${s.description.slice(0, 60)}`,
      section: s.affectedFiles[0] || 'unknown',
      detailSnapshot: [s.description, s.note].filter(Boolean).join(' — ').slice(0, 600),
      affectedFiles: s.affectedFiles,
      affectedPrinciples: [],
      pass: 'backfill',
      classification: null,                  // operator adds post-promote if desired
      deferredReason: s.deferredReason || 'out-of-scope',
      deferredAt: now,
      deferredRun: opts.runId,
      deferredRationale: s.deferredRationale,
      contentAliases: [],
      sensitive: false,
      ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
      ...(s.followupPr ? { followupPr: s.followupPr } : {}),
      ...(s.approver ? { approver: s.approver } : {}),
      ...(s.approvedAt ? { approvedAt: s.approvedAt } : {}),
      ...(s.policyRef ? { policyRef: s.policyRef } : {}),
      ...(s.owner || staging.defaultOwner ? { owner: s.owner || staging.defaultOwner } : {}),
    });
  }

  if (rejections.length > 0) {
    process.stderr.write(`  [backfill] ${rejections.length} approved records rejected before write:\n`);
    for (const r of rejections) {
      process.stderr.write(`    - ${r.topicId}: ${r.reason}\n`);
    }
  }

  if (entries.length === 0) {
    console.error('Error: all approved records failed validation — check rejections above');
    return 2;
  }

  const result = await writeDebtEntries(entries, { ledgerPath: opts.ledgerPath });
  process.stderr.write(`  [backfill] wrote to ${opts.ledgerPath}: ${result.inserted} new, ${result.updated} updated, ${result.total} total\n`);
  if (result.rejected.length > 0) {
    process.stderr.write(`  [backfill] ${result.rejected.length} entries rejected by schema:\n`);
    for (const r of result.rejected.slice(0, 5)) {
      process.stderr.write(`    - ${r.reason}\n`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    mode: 'promote',
    approved: approved.length,
    inserted: result.inserted,
    updated: result.updated,
    preWriteRejections: rejections.length,
    schemaRejections: result.rejected.length,
  }));
  return (result.inserted + result.updated) > 0 ? 0 : 2;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }

  let exitCode;
  if (opts.promote) {
    exitCode = await runPromote(opts);
  } else if (opts.sources) {
    exitCode = runStage(opts);
  } else {
    printUsage();
    process.exit(1);
  }
  process.exit(exitCode);
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
