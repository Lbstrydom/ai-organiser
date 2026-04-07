#!/usr/bin/env node
/**
 * @fileoverview TextGrad-lite prompt refinement — analyzes audit outcomes
 * and suggests prompt improvements. v2: example-driven with sanitization
 * and replay buffer sampling.
 * @module scripts/refine-prompts
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import fs from 'fs';
import path from 'path';
import { loadOutcomes, computePassEffectiveness, computePassEWR } from './lib/findings.mjs';
import { sanitizeOutcomes } from './lib/sanitizer.mjs';
import { reservoirSample } from './lib/rng.mjs';
import { PASS_NAMES, learningConfig } from './lib/config.mjs';

const MIN_EXAMPLES_THRESHOLD = learningConfig.minExamplesThreshold;

const REFINEMENT_SYSTEM = `You are a prompt engineer optimizing code audit prompts based on outcome data.

Given:
1. The current audit system prompt for a specific pass
2. Historical outcomes: which findings were accepted vs dismissed
3. Pattern statistics: which categories have high false-positive rates
4. Example findings (dismissed and accepted) with ruling rationale

Your job:
- Identify WHY certain finding types keep getting dismissed
- Suggest SPECIFIC edits to the system prompt to reduce false positives
- Preserve true-positive detection — don't make the prompt too lenient
- Format suggestions as ADD/REMOVE/CHANGE operations

Output format:
ADD: <text to add>
REMOVE: <text to remove>
CHANGE: <old text> → <new text>
RATIONALE: <why this change helps>`;

async function analyzePass(passName, outcomesPath) {
  const outcomes = loadOutcomes(outcomesPath);
  const passOutcomes = outcomes.filter(o => o.pass === passName);

  if (passOutcomes.length < 10) {
    console.log(`Not enough data for ${passName} (${passOutcomes.length} outcomes, need 10+)`);
    return;
  }

  const stats = computePassEffectiveness(passOutcomes);
  const ewr = computePassEWR(outcomes, passName);
  console.log(`\n=== ${passName} ===`);
  console.log(`Total: ${stats.total} | Accepted: ${stats.accepted} | Dismissed: ${stats.dismissed}`);
  console.log(`Acceptance rate: ${(stats.acceptanceRate * 100).toFixed(1)}%`);
  console.log(`EWR: ${ewr.ewr.toFixed(3)} | Confidence: ${ewr.confidence.toFixed(2)}`);

  const dismissedByCategory = {};
  for (const o of passOutcomes.filter(o => !o.accepted)) {
    const cat = o.category || 'unknown';
    if (!dismissedByCategory[cat]) dismissedByCategory[cat] = 0;
    dismissedByCategory[cat]++;
  }

  console.log('\nTop dismissed categories:');
  const sorted = Object.entries(dismissedByCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted.slice(0, 5)) {
    console.log(`  ${count}x ${cat}`);
  }

  console.log('\nTo generate prompt refinement suggestions, run with --suggest flag and provide ANTHROPIC_API_KEY or GEMINI_API_KEY');
}

/**
 * Suggest refinements with example-driven approach.
 * Uses sanitized outcomes and replay buffer sampling.
 */
async function suggestRefinements(passName, outcomesPath) {
  const outcomes = loadOutcomes(outcomesPath);
  const passOutcomes = outcomes.filter(o => o.pass === passName);

  if (passOutcomes.length < 10) {
    console.log(`Not enough data for ${passName} (${passOutcomes.length}/10 required)`);
    return { status: 'INSUFFICIENT_DATA', message: `Only ${passOutcomes.length} outcomes` };
  }

  // Sanitize before any external LLM call
  const sanitized = sanitizeOutcomes(passOutcomes);

  // Empty-state handling
  if (sanitized.length < MIN_EXAMPLES_THRESHOLD) {
    process.stderr.write(`[refine] Only ${sanitized.length} sanitized outcomes (need ${MIN_EXAMPLES_THRESHOLD}) — stats-only refinement\n`);
    if (sanitized.length === 0) {
      return { status: 'INSUFFICIENT_DATA', message: `Only ${sanitized.length} sanitized outcomes` };
    }
  }

  // Compute stats
  const accepted = passOutcomes.filter(o => o.accepted);
  const dismissed = passOutcomes.filter(o => !o.accepted);

  const dismissedByCategory = {};
  for (const o of dismissed) {
    const cat = o.category || 'unknown';
    dismissedByCategory[cat] = (dismissedByCategory[cat] || 0) + 1;
  }

  const statsBlock = [
    `Pass: ${passName}`,
    `Total: ${passOutcomes.length} | Accepted: ${accepted.length} | Dismissed: ${dismissed.length}`,
    `Acceptance rate: ${(accepted.length / passOutcomes.length * 100).toFixed(1)}%`,
    '',
    'Top dismissed categories:',
    ...Object.entries(dismissedByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cat, count]) => `  ${count}x ${cat}`)
  ].join('\n');

  // Build example block from sanitized outcomes
  let exampleBlock = '';
  if (sanitized.length >= MIN_EXAMPLES_THRESHOLD) {
    const sanDismissed = sanitized.filter(o => !o.accepted && o.detail);
    const sanAccepted = sanitized.filter(o => o.accepted && o.detail);

    // Mixed sampling: 3 recent + 2 random (replay buffer)
    const dismissedExamples = [
      ...sanDismissed.sort((a, b) => {
        const order = { recent: 0, mid: 1, old: 2 };
        return (order[a._recencyBucket] || 2) - (order[b._recencyBucket] || 2);
      }).slice(0, 3),
      ...reservoirSample(sanDismissed, 2)
    ].map(o => `  - [${o.severity}] ${o.category} in ${o.primaryFile}: ${o.detail?.slice(0, 100)} (ruling: ${o.ruling}, rationale: ${o.rulingRationale?.slice(0, 80)})`);

    const acceptedExamples = reservoirSample(sanAccepted, 3)
      .map(o => `  - [${o.severity}] ${o.category} in ${o.primaryFile}: ${o.detail?.slice(0, 100)}`);

    exampleBlock = [
      '',
      'DISMISSED FINDINGS (false positives — the prompt should avoid generating these):',
      ...dismissedExamples,
      '',
      'ACCEPTED FINDINGS (true positives — the prompt should keep generating these):',
      ...acceptedExamples
    ].join('\n');
  }

  console.log('Generating prompt refinement suggestions...\n');

  let suggestion = null;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: REFINEMENT_SYSTEM,
        messages: [{ role: 'user', content: `Outcome data:\n\n${statsBlock}${exampleBlock}\n\nSuggest prompt refinements to reduce false positives.` }]
      });
      suggestion = response.content?.[0]?.text;
    } catch (err) {
      console.log(`Haiku failed: ${err.message}`);
    }
  }

  if (!suggestion && process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Outcome data:\n\n${statsBlock}${exampleBlock}\n\nSuggest prompt refinements to reduce false positives.`,
        config: { systemInstruction: REFINEMENT_SYSTEM, maxOutputTokens: 2000 }
      });
      suggestion = response.text;
    } catch (err) {
      console.log(`Flash failed: ${err.message}`);
    }
  }

  if (suggestion) {
    console.log('=== SUGGESTED REFINEMENTS ===\n');
    console.log(suggestion);
    console.log('\nReview these suggestions and apply manually to the pass prompt.');
    console.log('After applying, register the new prompt as a bandit variant:');
    console.log(`  node scripts/bandit.mjs add ${passName} v2-refined`);
    return { status: 'OK', suggestion };
  } else {
    console.log('No LLM available for suggestions. Set ANTHROPIC_API_KEY or GEMINI_API_KEY.');
    return { status: 'NO_LLM' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const passName = args[0];
  const outcomesPath = args.includes('--outcomes')
    ? args[args.indexOf('--outcomes') + 1]
    : '.audit/outcomes.jsonl';

  if (!passName || passName === 'help') {
    console.log('Usage:');
    console.log('  node scripts/refine-prompts.mjs <pass-name> [--outcomes <path>] [--suggest]');
    console.log('  node scripts/refine-prompts.mjs stats [--outcomes <path>]');
    console.log('');
    console.log(`Pass names: ${PASS_NAMES.join(', ')}`);
    process.exit(0);
  }

  if (passName === 'stats') {
    const outcomes = loadOutcomes(outcomesPath);
    console.log(`Total outcomes: ${outcomes.length}`);
    for (const pass of PASS_NAMES) {
      const stats = computePassEffectiveness(outcomes, pass);
      const ewr = computePassEWR(outcomes, pass);
      if (stats.total > 0) {
        console.log(`  ${pass.padEnd(15)} ${stats.total} findings, ${(stats.acceptanceRate*100).toFixed(0)}% accepted, EWR: ${ewr.ewr.toFixed(3)}`);
      }
    }
    return;
  }

  if (args.includes('--suggest')) {
    await suggestRefinements(passName, outcomesPath);
  } else {
    await analyzePass(passName, outcomesPath);
  }
}

main();
