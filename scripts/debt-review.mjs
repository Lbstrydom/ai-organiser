#!/usr/bin/env node
/**
 * @fileoverview Phase D.3 — debt review CLI.
 *
 * Clusters accumulated tech-debt into refactor candidates ranked by leverage.
 * Three modes:
 *   default (LLM)   — sends debt to GPT-5.4 for clustering + effort estimation
 *   --local-only    — deterministic heuristic clustering (no LLM), good for
 *                     sensitive debt or offline/cost-sensitive workflows
 *   --include-sensitive — explicit opt-in to send sensitive entries to LLM
 *                     (prints a warning, requires terminal confirmation)
 *
 * Output: structured markdown with clusters, patterns, and ranked refactor plan.
 * Optional: --write-plan-doc creates docs/plans/refactor-<cluster>.md.
 *
 * Exit codes (Phase D CLI contract §2.13):
 *   0 = success (including empty ledger)
 *   1 = operational error (missing API key without --local-only, corrupt ledger)
 *   2 = not used here
 *   3 = sensitivity gate tripped (would have sent sensitive data without opt-in)
 *
 * @module scripts/debt-review
 */

import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';

import { DebtReviewResultSchema } from './lib/schemas.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { DEFAULT_DEBT_EVENTS_PATH } from './lib/debt-events.mjs';
import {
  rankRefactorsByLeverage, findStaleEntries, oldestEntryDays,
  buildLocalClusters, findBudgetViolations, EFFORT_WEIGHTS,
} from './lib/debt-review-helpers.mjs';
import { openaiConfig } from './lib/config.mjs';

// ── CLI Arg Parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    localOnly: args.includes('--local-only'),
    includeSensitive: args.includes('--include-sensitive'),
    writePlanDoc: args.includes('--write-plan-doc'),
    ttlDays: parseInt(get('--ttl-days') || '180', 10),
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    eventsPath: get('--events') || DEFAULT_DEBT_EVENTS_PATH,
    outFile: get('--out'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-review.mjs [options]

Cluster accumulated tech-debt into refactor candidates ranked by leverage.

Modes (default = LLM clustering via GPT-5.4):
  --local-only           Deterministic heuristic clustering, no external LLM
  --include-sensitive    Include sensitive entries in LLM payload (opt-in)

Options:
  --ttl-days <n>         Flag entries older than N days as stale (default: 180)
  --ledger <path>        Debt ledger path (default: .audit/tech-debt.json)
  --events <path>        Event log path (default: .audit/local/debt-events.jsonl)
  --out <file>           Write markdown to file (default: stdout)
  --write-plan-doc       Also write top refactor to docs/plans/refactor-<id>.md

Exit codes: 0=ok, 1=op-error, 3=sensitivity-gate (blocked)
`);
}

// ── Markdown Rendering ──────────────────────────────────────────────────────

function renderMarkdown({ ledger, review, violations, mode }) {
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);
  lines.push(`# Debt Review — ${now}`);
  lines.push('');
  lines.push(`- **Mode**: ${mode}`);
  lines.push(`- **Entries**: ${ledger.entries.length}`);
  lines.push(`- **Clusters**: ${review.clusters.length}`);
  lines.push(`- **Oldest entry**: ${review.summary.oldestEntryDays} days`);
  lines.push(`- **Stale (>TTL)**: ${review.summary.staleEntries.length}`);
  if (violations.length > 0) {
    lines.push(`- **Budget violations**: ${violations.length}`);
  }
  lines.push('');

  if (violations.length > 0) {
    lines.push('## Budget Violations');
    for (const v of violations) {
      lines.push(`- **${v.path}**: ${v.count} entries / ${v.budget} budget (over by ${v.count - v.budget})`);
    }
    lines.push('');
  }

  lines.push('## Clusters');
  if (review.clusters.length === 0) {
    lines.push('_No clusters identified._');
  } else {
    for (const c of review.clusters) {
      lines.push(`### ${c.title} _(${c.kind})_`);
      lines.push(c.rationale);
      lines.push(`- entries: \`${c.entries.join('`, `')}\``);
      lines.push('');
    }
  }

  lines.push('## Refactor Plan (ranked by leverage)');
  if (review.refactorPlan.length === 0) {
    lines.push('_No refactor candidates._');
  } else {
    for (let i = 0; i < review.refactorPlan.length; i++) {
      const r = review.refactorPlan[i];
      lines.push(`### ${i + 1}. ${r.clusterId} — leverage ${r.leverageScore} (effort: ${r.effortEstimate})`);
      lines.push(`- **Targets**: ${r.targetModules.join(', ')}`);
      lines.push(`- **Resolves**: ${r.resolvedTopicIds.length} entries`);
      lines.push(`- **Effort rationale**: ${r.effortRationale}`);
      if (r.risks.length > 0) {
        lines.push(`- **Risks**: ${r.risks.join('; ')}`);
      }
      lines.push(`- **Rollback**: ${r.rollbackStrategy}`);
      lines.push('');
    }
  }

  if (review.summary.staleEntries.length > 0) {
    lines.push('## Stale Entries (consider resolving or promoting to accepted-permanent)');
    for (const tid of review.summary.staleEntries) {
      const e = ledger.entries.find(x => x.topicId === tid);
      const cat = e?.category ? ` — ${e.category}` : '';
      lines.push(`- \`${tid}\`${cat}`);
    }
    lines.push('');
  }

  lines.push('## Reasoning');
  lines.push(review.reasoning);

  return lines.join('\n');
}

// ── Local-Only Clustering ───────────────────────────────────────────────────

function runLocalClustering(entries, ttlDays) {
  const now = new Date();
  const clusters = buildLocalClusters(entries);
  const stale = findStaleEntries(entries, ttlDays, now);

  // Build a simple refactor candidate per cluster (no effort estimation without LLM)
  const refactors = clusters.map(c => ({
    clusterId: c.id,
    targetModules: c.kind === 'file' ? [c.id.replace(/^file:/, '')] : [],
    resolvedTopicIds: c.entries,
    effortEstimate: c.entries.length >= 5 ? 'MAJOR' : c.entries.length >= 3 ? 'MEDIUM' : 'EASY',
    effortRationale: `Heuristic estimate from ${c.entries.length} members in ${c.kind} cluster.`,
    risks: ['Heuristic clustering — no LLM judgment on interactions'],
    rollbackStrategy: 'Revert commit; no state changes outside source files.',
  }));
  const ranked = rankRefactorsByLeverage(refactors, entries);

  return {
    summary: {
      totalEntries: entries.length,
      clustersIdentified: clusters.length,
      oldestEntryDays: oldestEntryDays(entries, now),
      staleEntries: stale,
    },
    clusters,
    refactorPlan: ranked,
    reasoning: `Deterministic heuristic clustering: ${clusters.length} clusters across ${entries.length} entries. LLM-based analysis would identify cross-cluster patterns this mode cannot detect. Run without --local-only for richer refactor suggestions.`,
  };
}

// ── LLM Clustering (GPT-5.4) ────────────────────────────────────────────────

const DEBT_REVIEW_SYSTEM = `You are a senior engineer reviewing accumulated technical debt.

You receive a JSON list of debt entries. Each entry has: topicId, severity,
category, detailSnapshot (summary), affectedFiles, affectedPrinciples,
deferredReason, deferredRationale, distinctRunCount (how many audits it
surfaced in — higher = more systemic), classification (sonarType + effort).

YOUR TASKS:

1. CLUSTER entries by:
   - File: entries citing the same module → candidate for module refactor
   - Principle: entries violating the same principle across files → systemic pattern
   - Recurrence: entries with distinctRunCount >= 3 → high-priority, systemic

2. IDENTIFY REFACTOR CANDIDATES: for each cluster, propose a refactor pass:
   - clusterId: the cluster this refactor resolves
   - targetModules: which files/modules the refactor touches
   - resolvedTopicIds: which debt entries would be cleared
   - effortEstimate: TRIVIAL | EASY | MEDIUM | MAJOR | CRITICAL
   - effortRationale: why that effort estimate
   - risks: what could go wrong (up to 5)
   - rollbackStrategy: how to undo if it fails

3. REASONING: brief summary of patterns you see across the entire ledger.

RULES:
- Do NOT estimate leverageScore — the server computes it from your effort + sonarType weights.
- Prefer fewer, higher-leverage clusters over many shallow ones.
- Group entries aggressively — a cluster of 1 is not useful.
- Match clusterId to the first word of the cluster title (kebab-case).`;

async function runLLMClustering(openai, entries, ttlDays, includeSensitive) {
  const now = new Date();
  const stale = findStaleEntries(entries, ttlDays, now);

  // Filter sensitive entries unless opt-in
  const toSend = includeSensitive ? entries : entries.filter(e => !e.sensitive);
  const sensitiveCount = entries.length - toSend.length;

  if (toSend.length === 0) {
    // All sensitive, none to analyze
    return {
      summary: {
        totalEntries: entries.length,
        clustersIdentified: 0,
        oldestEntryDays: oldestEntryDays(entries, now),
        staleEntries: stale,
      },
      clusters: [],
      refactorPlan: [],
      reasoning: `All ${entries.length} entries marked sensitive — not sent to external LLM. Use --include-sensitive to override or --local-only for heuristic clustering.`,
    };
  }

  // Build compact payload
  const payload = toSend.map(e => ({
    topicId: e.topicId,
    severity: e.severity,
    category: e.category,
    detailSnapshot: (e.detailSnapshot || '').slice(0, 300),
    affectedFiles: e.affectedFiles,
    affectedPrinciples: e.affectedPrinciples,
    deferredReason: e.deferredReason,
    distinctRunCount: e.distinctRunCount ?? 0,
    sonarType: e.classification?.sonarType ?? null,
  }));

  const userPrompt = `Debt ledger with ${toSend.length} entries${sensitiveCount > 0 ? ` (${sensitiveCount} sensitive entries withheld)` : ''}:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;

  process.stderr.write(`  [debt-review] Sending ${toSend.length} entries to ${openaiConfig.model}...\n`);
  const startMs = Date.now();
  const response = await openai.responses.parse({
    model: openaiConfig.model,
    reasoning: { effort: 'medium' },
    instructions: DEBT_REVIEW_SYSTEM,
    input: userPrompt,
    text: { format: zodTextFormat(DebtReviewResultSchema, 'debt_review') },
    max_output_tokens: 8000,
  });
  process.stderr.write(`  [debt-review] Done in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);

  const result = response.output_parsed;
  // Force our server-side summary values (LLM may get them wrong)
  result.summary.totalEntries = entries.length;
  result.summary.oldestEntryDays = oldestEntryDays(entries, now);
  result.summary.staleEntries = stale;
  result.summary.clustersIdentified = result.clusters.length;

  // Compute leverage + rank
  result.refactorPlan = rankRefactorsByLeverage(result.refactorPlan, entries);

  // If sensitive entries were withheld, note it in reasoning
  if (sensitiveCount > 0) {
    result.reasoning = `[${sensitiveCount} sensitive entries not sent to LLM] ` + result.reasoning;
  }

  return result;
}

// ── write-plan-doc ──────────────────────────────────────────────────────────

function writeTopRefactorPlanDoc(review, ledger) {
  if (review.refactorPlan.length === 0) return null;
  const top = review.refactorPlan[0];
  const safeId = top.clusterId.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const planPath = path.join('docs', 'plans', `refactor-${safeId}.md`);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  const members = top.resolvedTopicIds
    .map(tid => ledger.entries.find(e => e.topicId === tid))
    .filter(Boolean);

  const md = [
    `# Refactor: ${top.clusterId}`,
    '',
    `- **Generated**: ${new Date().toISOString().slice(0, 10)} by debt-review`,
    `- **Leverage score**: ${top.leverageScore}`,
    `- **Effort**: ${top.effortEstimate} (weight ${EFFORT_WEIGHTS[top.effortEstimate]})`,
    `- **Resolves**: ${top.resolvedTopicIds.length} debt entries`,
    '',
    '## Target Modules',
    ...top.targetModules.map(m => `- \`${m}\``),
    '',
    '## Effort Rationale',
    top.effortRationale,
    '',
    '## Risks',
    ...top.risks.map(r => `- ${r}`),
    '',
    '## Rollback Strategy',
    top.rollbackStrategy,
    '',
    '## Debt Entries Resolved',
    '',
    '| topicId | severity | category |',
    '|---|---|---|',
    ...members.map(e => `| \`${e.topicId}\` | ${e.severity} | ${e.category} |`),
    '',
  ].join('\n');

  fs.writeFileSync(planPath, md, 'utf-8');
  return planPath;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }

  // Load ledger
  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, eventsPath: opts.eventsPath });
  } catch (err) {
    console.error(`Error reading debt ledger: ${err.message}`);
    process.exit(1);
  }

  if (ledger.entries.length === 0) {
    const output = '# Debt Review\n\n_Ledger is empty — no debt to review._\n';
    if (opts.outFile) fs.writeFileSync(opts.outFile, output, 'utf-8');
    else process.stdout.write(output);
    process.stderr.write('  [debt-review] ledger empty — no-op\n');
    process.exit(0);
  }

  // Sensitivity gate — refuse to send sensitive data without explicit opt-in
  const sensitiveEntries = ledger.entries.filter(e => e.sensitive);
  if (sensitiveEntries.length > 0 && !opts.localOnly && !opts.includeSensitive) {
    process.stderr.write(`  [debt-review] ${sensitiveEntries.length} sensitive entries in ledger — filtering from external LLM payload. Use --include-sensitive to override or --local-only for local clustering.\n`);
  }

  // Read budgets from ledger (optional top-level field)
  const rawLedger = JSON.parse(fs.readFileSync(path.resolve(opts.ledgerPath), 'utf-8'));
  const violations = findBudgetViolations(ledger.entries, rawLedger.budgets || {});

  let review;
  let mode;
  if (opts.localOnly) {
    mode = 'local-only';
    process.stderr.write('  [debt-review] local-only mode (no LLM)\n');
    review = runLocalClustering(ledger.entries, opts.ttlDays);
  } else {
    mode = opts.includeSensitive ? 'llm (include-sensitive)' : 'llm';
    if (!process.env.OPENAI_API_KEY) {
      console.error('Error: OPENAI_API_KEY required for LLM mode (or use --local-only)');
      process.exit(1);
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    review = await runLLMClustering(openai, ledger.entries, opts.ttlDays, opts.includeSensitive);
  }

  // Render markdown
  const md = renderMarkdown({ ledger, review, violations, mode });
  if (opts.outFile) {
    fs.writeFileSync(opts.outFile, md, 'utf-8');
    process.stderr.write(`  [debt-review] wrote ${md.length} chars to ${opts.outFile}\n`);
  } else {
    process.stdout.write(md + '\n');
  }

  // Optional plan doc
  if (opts.writePlanDoc) {
    const planPath = writeTopRefactorPlanDoc(review, ledger);
    if (planPath) {
      process.stderr.write(`  [debt-review] wrote refactor plan to ${planPath}\n`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
