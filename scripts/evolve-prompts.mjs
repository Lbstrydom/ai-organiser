#!/usr/bin/env node
/**
 * @fileoverview TextGrad prompt evolution pipeline.
 * LLM generates prompt variants, bandit A/B tests them, human reviews winners.
 *
 * Usage:
 *   node scripts/evolve-prompts.mjs evolve [--outcomes <path>] [--out <file>]
 *   node scripts/evolve-prompts.mjs review [--out <file>]
 *   node scripts/evolve-prompts.mjs promote <pass> <revisionId> [--out <file>]
 *   node scripts/evolve-prompts.mjs kill <pass> <revisionId>
 *   node scripts/evolve-prompts.mjs stats [--outcomes <path>]
 *
 * @module scripts/evolve-prompts
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PromptBandit } from './bandit.mjs';
import { loadOutcomes, computePassEWR } from './lib/findings.mjs';
import { sanitizeOutcomes, backfillPrimaryFile } from './lib/sanitizer.mjs';
import { reservoirSample } from './lib/rng.mjs';
import {
  revisionId, saveRevision, getActiveRevisionId, getActivePrompt,
  promoteRevision, abandonRevision
} from './lib/prompt-registry.mjs';
import { AppendOnlyStore, MutexFileStore } from './lib/file-store.mjs';
import { createLearningAdapter } from './lib/llm-wrappers.mjs';
import { zodToGeminiSchema } from './lib/schemas.mjs';
import { PASS_NAMES, GLOBAL_CONTEXT_BUCKET, learningConfig } from './lib/config.mjs';

const MIN_EXAMPLES_THRESHOLD = learningConfig.minExamplesThreshold;

// ── Schemas ─────────────────────────────────────────────────────────────────

export const GeneratedVariantSchema = z.object({
  promptText: z.string().min(100).max(10000),
  diff: z.string().describe('Human-readable diff from parent prompt'),
  rationale: z.string().max(500),
  targetedPatterns: z.array(z.string()).describe('FP patterns this variant aims to fix')
});

export const ExperimentRecordSchema = z.object({
  experimentId: z.string(),
  timestamp: z.number(),
  pass: z.string(),
  revisionId: z.string(),
  parentRevisionId: z.string(),
  parentEWR: z.number(),
  parentConfidence: z.number(),
  parentEffectiveSampleSize: z.number(),
  status: z.enum(['active', 'converged', 'promoted', 'killed', 'stale']),
  rationale: z.string().optional(),
  finalEWR: z.number().optional(),
  finalConfidence: z.number().optional(),
  totalPulls: z.number().optional()
});

// ── Stores ──────────────────────────────────────────────────────────────────

const experimentStore = new AppendOnlyStore('.audit/experiments.jsonl');

function getExperimentManifestStore(experimentId) {
  return new MutexFileStore(`.audit/experiment-manifests/${experimentId}.json`);
}

// ── Evolution System Prompt ─────────────────────────────────────────────────

const EVOLUTION_SYSTEM = `You are a prompt engineer evolving code audit prompts based on outcome data.

You are given:
1. The current audit prompt for a specific pass
2. Examples of dismissed findings (false positives — the prompt should avoid generating these)
3. Examples of accepted findings (true positives — the prompt should keep generating these)
4. Outcome statistics

Your job: Generate an improved version of the prompt that:
- Reduces false positives by being more precise about what to flag
- Preserves true positive detection — don't make the prompt too lenient
- Makes targeted changes, not wholesale rewrites
- Focuses on the patterns that cause the most false positives

Output a complete new prompt text (not a diff), plus a rationale and list of targeted patterns.`;

// ── Service Functions ───────────────────────────────────────────────────────

/**
 * Identify worst pass and generate a variant prompt.
 * @returns {{ status: string, message?: string, experiment?: object }}
 */
export async function evolveWorstPass(outcomesPath, bandit, adapter, options = {}) {
  const outcomes = loadOutcomes(outcomesPath);

  // Find worst pass using canonical EWR metric
  const passStats = PASS_NAMES
    .map(p => ({ pass: p, ...computePassEWR(outcomes, p) }))
    .filter(s => s.n >= 10 && s.confidence >= 0.5)
    .sort((a, b) => a.ewr - b.ewr);

  if (passStats.length === 0) {
    return { status: 'INSUFFICIENT_DATA', message: 'Not enough confident data for any pass' };
  }

  const worst = passStats[0];
  if (worst.ewr > 0.7) {
    return { status: 'NO_ACTION', message: 'All passes above 0.7 EWR — no evolution needed' };
  }

  const currentPrompt = getActivePrompt(worst.pass);
  const currentRevisionIdVal = getActiveRevisionId(worst.pass);

  if (!currentPrompt) {
    return { status: 'NO_ACTION', message: `No active prompt for ${worst.pass} — bootstrap first` };
  }

  // Backfill legacy outcomes missing primaryFile before sanitization
  const passOutcomes = outcomes.filter(o => o.pass === worst.pass);
  backfillPrimaryFile(passOutcomes, []);
  const sanitized = sanitizeOutcomes(passOutcomes);
  if (sanitized.length < MIN_EXAMPLES_THRESHOLD) {
    return { status: 'INSUFFICIENT_DATA', message: `Only ${sanitized.length} sanitized examples for ${worst.pass}` };
  }

  const dismissed = sanitized.filter(o => !o.accepted);
  const accepted = sanitized.filter(o => o.accepted);
  const dismissedExamples = [
    ...dismissed.sort((a, b) => {
      const order = { recent: 0, mid: 1, old: 2 };
      return (order[a._recencyBucket] || 2) - (order[b._recencyBucket] || 2);
    }).slice(0, 3),
    ...reservoirSample(dismissed, 2)
  ].map(formatExample);
  const acceptedExamples = reservoirSample(accepted, 3).map(formatExample);

  const exampleBlock = [
    'DISMISSED FINDINGS (false positives — the prompt should avoid generating these):',
    ...dismissedExamples,
    '',
    'ACCEPTED FINDINGS (true positives — the prompt should keep generating these):',
    ...acceptedExamples
  ].join('\n');

  const statsBlock = `Pass: ${worst.pass} | EWR: ${worst.ewr.toFixed(3)} | Confidence: ${worst.confidence.toFixed(2)} | N: ${worst.n}`;

  const userPrompt = `Current prompt:\n\n${currentPrompt}\n\nOutcome data:\n\n${statsBlock}\n\n${exampleBlock}\n\nGenerate an improved version of this prompt.`;

  // Generate variant via LLM adapter
  const variant = await adapter.generateViaLLM(
    EVOLUTION_SYSTEM,
    userPrompt,
    GeneratedVariantSchema,
    zodToGeminiSchema(GeneratedVariantSchema)
  );

  if (!variant) {
    return { status: 'NO_ACTION', message: 'LLM failed to generate variant' };
  }

  // Compute immutable revision ID from content hash
  const newRevisionIdVal = revisionId(variant.result.promptText);
  const experimentId = `${worst.pass}-${newRevisionIdVal}`;

  // Guard: prevent resurrection of resolved experiments
  const allExperiments = experimentStore.loadAll();
  const existing = allExperiments.find(e => e.experimentId === experimentId);
  if (existing && ['killed', 'promoted', 'stale'].includes(existing.status)) {
    return { status: 'NO_ACTION', message: `Experiment ${experimentId} already resolved (${existing.status})` };
  }

  try {
    const manifestStore = getExperimentManifestStore(experimentId);
    const manifest = {
      experimentId,
      steps: { revision_saved: false, arm_registered: false, active: false }
    };

    // Step 1: Persist prompt revision
    saveRevision(worst.pass, newRevisionIdVal, variant.result.promptText, {
      source: 'textgrad-auto',
      parentRevisionId: currentRevisionIdVal,
      generatedAt: Date.now()
    });
    manifest.steps.revision_saved = true;
    manifestStore.save(manifest);

    // Step 2: Register bandit arm
    bandit.addArm(worst.pass, newRevisionIdVal, null, {
      source: 'textgrad-auto',
      parentRevisionId: currentRevisionIdVal,
      promptRevisionId: newRevisionIdVal,
      syncable: false
    });
    manifest.steps.arm_registered = true;
    manifestStore.save(manifest);

    // Step 3: Log experiment
    const experiment = {
      experimentId,
      timestamp: Date.now(),
      pass: worst.pass,
      revisionId: newRevisionIdVal,
      parentRevisionId: currentRevisionIdVal,
      parentEWR: worst.ewr,
      parentConfidence: worst.confidence,
      parentEffectiveSampleSize: worst.n,
      rationale: variant.result.rationale,
      status: 'active'
    };

    experimentStore.append(experiment);
    manifest.steps.active = true;
    manifestStore.save(manifest);

    bandit.flush();
    return { status: 'CREATED', experiment };

  } catch (err) {
    // Complete rollback: deactivate arm first (so abandonRevision won't be blocked by active refs)
    const armKey = `${worst.pass}:${newRevisionIdVal}:${GLOBAL_CONTEXT_BUCKET}`;
    if (bandit.arms[armKey]) {
      delete bandit.arms[armKey];
      bandit.flush();
    }
    abandonRevision(worst.pass, newRevisionIdVal, bandit);
    // Mark manifest as failed for startup reconciliation
    try {
      const manifestStore = getExperimentManifestStore(experimentId);
      manifestStore.save({ experimentId, steps: { revision_saved: true, arm_registered: false, active: false }, failed: true });
    } catch { /* best effort */ }
    process.stderr.write(`[evolve] Failed to persist variant: ${err.message}\n`);
    return { status: 'NO_ACTION', message: `Failed: ${err.message}` };
  }
}

/**
 * Show converged experiments ready for human review.
 */
export function reviewExperiments(bandit) {
  const allExperiments = experimentStore.loadAll();

  // Latest version of each experiment wins
  const byId = new Map();
  for (const e of allExperiments) byId.set(e.experimentId, e);

  const active = [...byId.values()]
    .filter(e => e.status === 'active')
    .map(e => checkBaselineValidity(e));

  const converged = active.filter(e => {
    if (e.status === 'stale') return false;
    // Check convergence scoped to experiment's parent/variant pair, not all pass arms
    const variantArm = bandit.arms[`${e.pass}:${e.revisionId}:${GLOBAL_CONTEXT_BUCKET}`];
    const parentArm = bandit.arms[`${e.pass}:${e.parentRevisionId}:${GLOBAL_CONTEXT_BUCKET}`];
    if (!variantArm || !parentArm) return false;
    if (variantArm.pulls < 10) return false;
    // Convergence: experiment variant's CI separates from parent
    const vMean = variantArm.alpha / (variantArm.alpha + variantArm.beta);
    const vVar = (variantArm.alpha * variantArm.beta) / ((variantArm.alpha + variantArm.beta) ** 2 * (variantArm.alpha + variantArm.beta + 1));
    const pMean = parentArm.alpha / (parentArm.alpha + parentArm.beta);
    const pVar = (parentArm.alpha * parentArm.beta) / ((parentArm.alpha + parentArm.beta) ** 2 * (parentArm.alpha + parentArm.beta + 1));
    return Math.abs(vMean - pMean) > 2 * (Math.sqrt(vVar) + Math.sqrt(pVar));
  });

  if (converged.length === 0) {
    return { status: 'NO_ACTION', experiments: [], message: 'No experiments have converged' };
  }

  const results = converged.map(e => {
    const arms = bandit.getStats().filter(a => a.pass === e.pass);
    const variantArm = arms.find(a => a.variant === e.revisionId);
    const parentArm = arms.find(a => a.variant === e.parentRevisionId);
    return {
      ...e,
      variantStats: variantArm || null,
      parentStats: parentArm || null,
      recommendation: (variantArm && parentArm &&
        parseFloat(variantArm.estimatedRate) > parseFloat(parentArm.estimatedRate))
        ? 'PROMOTE' : 'KILL'
    };
  });

  return { status: 'FOUND', experiments: results };
}

/**
 * Promote a revision to be the new default.
 */
export function promoteExperiment(passName, revId) {
  promoteRevision(passName, revId);

  // Update experiment record
  const allExperiments = experimentStore.loadAll();
  const experiment = allExperiments.find(e => e.revisionId === revId && e.pass === passName);
  if (experiment) {
    experiment.status = 'promoted';
    experimentStore.append(experiment);
  }

  return { status: 'PROMOTED', pass: passName, revisionId: revId };
}

/**
 * Kill an experiment — deactivate arm, mark experiment killed.
 */
export function killExperiment(passName, revId, bandit) {
  abandonRevision(passName, revId, bandit);

  const allExperiments = experimentStore.loadAll();
  const experiment = allExperiments.find(e => e.revisionId === revId && e.pass === passName);
  if (experiment) {
    experiment.status = 'killed';
    experimentStore.append(experiment);
  }

  return { status: 'KILLED', pass: passName, revisionId: revId };
}

/**
 * Show EWR per pass and active experiments.
 */
export function showStats(outcomesPath, bandit) {
  const outcomes = loadOutcomes(outcomesPath);
  const passStats = PASS_NAMES.map(p => ({ pass: p, ...computePassEWR(outcomes, p) }));

  const allExperiments = experimentStore.loadAll();
  const byId = new Map();
  for (const e of allExperiments) byId.set(e.experimentId, e);
  const active = [...byId.values()].filter(e => e.status === 'active');

  return { passStats, activeExperiments: active, banditStats: bandit.getStats() };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatExample(o) {
  return `  - [${o.severity || '?'}] ${o.category || '?'} in ${o.primaryFile || '?'}: ${o.detail?.slice(0, 100) || ''}`;
}

function checkBaselineValidity(experiment) {
  const currentDefault = getActiveRevisionId(experiment.pass);
  if (currentDefault !== experiment.parentRevisionId && experiment.status === 'active') {
    experiment.status = 'stale';
    experimentStore.append(experiment);
    process.stderr.write(`  [evolve] Experiment ${experiment.experimentId} marked stale: default changed\n`);
  }
  return experiment;
}

/**
 * Reconcile orphaned experiments from incomplete prior runs.
 */
export function reconcileOrphanedExperiments(bandit) {
  const manifestDir = path.resolve('.audit/experiment-manifests');
  if (!fs.existsSync(manifestDir)) return;

  for (const file of fs.readdirSync(manifestDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf-8'));
      if (manifest.steps?.active) continue; // Completed successfully

      if (manifest.steps?.revision_saved && !manifest.steps?.arm_registered) {
        process.stderr.write(`  [evolve] Orphaned revision: ${manifest.experimentId} — cleaning up\n`);
        // Can't easily abandon without knowing pass — skip
      }
    } catch { /* skip corrupted manifests */ }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const outcomesPath = args.includes('--outcomes')
    ? args[args.indexOf('--outcomes') + 1]
    : '.audit/outcomes.jsonl';
  const outFile = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : null;

  const bandit = new PromptBandit();

  if (cmd === 'evolve') {
    // Build adapter from available env vars
    const providers = {};
    if (process.env.GEMINI_API_KEY) {
      const { GoogleGenAI } = await import('@google/genai');
      providers.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      providers.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    const adapter = createLearningAdapter(providers);
    const result = await evolveWorstPass(outcomesPath, bandit, adapter);

    if (outFile && result.experiment) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result.experiment, null, 2));
    }

    if (result.status === 'CREATED') {
      console.log(`Created experiment: ${result.experiment.experimentId} for ${result.experiment.pass} (EWR: ${result.experiment.parentEWR.toFixed(3)})`);
      process.exit(0);
    } else if (result.status === 'INSUFFICIENT_DATA' || result.status === 'NO_ACTION') {
      console.log(result.message);
      process.exit(2);
    } else {
      console.error(result.message || 'Unknown error');
      process.exit(1);
    }
  }

  if (cmd === 'review') {
    const result = reviewExperiments(bandit);
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result.experiments, null, 2));
    }
    if (result.experiments.length > 0) {
      for (const e of result.experiments) {
        console.log(`${e.pass} | ${e.revisionId} | Recommendation: ${e.recommendation}`);
      }
      process.exit(0);
    } else {
      console.log(result.message);
      process.exit(2);
    }
  }

  if (cmd === 'promote') {
    const pass = args[1];
    const rev = args[2];
    if (!pass || !rev) { console.log('Usage: evolve-prompts.mjs promote <pass> <revisionId>'); process.exit(1); }
    const result = promoteExperiment(pass, rev);
    console.log(`Promoted ${rev} as default for ${pass}`);
    process.exit(0);
  }

  if (cmd === 'kill') {
    const pass = args[1];
    const rev = args[2];
    if (!pass || !rev) { console.log('Usage: evolve-prompts.mjs kill <pass> <revisionId>'); process.exit(1); }
    killExperiment(pass, rev, bandit);
    console.log(`Killed experiment for ${pass}:${rev}`);
    process.exit(0);
  }

  if (cmd === 'stats') {
    const result = showStats(outcomesPath, bandit);
    console.log('\nPass EWR:');
    for (const s of result.passStats) {
      console.log(`  ${s.pass.padEnd(15)} EWR: ${s.ewr.toFixed(3)} | Confidence: ${s.confidence.toFixed(2)} | N: ${s.n}`);
    }
    if (result.activeExperiments.length > 0) {
      console.log(`\nActive experiments: ${result.activeExperiments.length}`);
      for (const e of result.activeExperiments) {
        console.log(`  ${e.pass}: ${e.revisionId} (parent EWR: ${e.parentEWR.toFixed(3)})`);
      }
    }
    process.exit(0);
  }

  console.log('Usage: node scripts/evolve-prompts.mjs <evolve|review|promote|kill|stats> [options]');
  process.exit(1);
}

if (process.argv[1]?.endsWith('evolve-prompts.mjs')) {
  main();
}
