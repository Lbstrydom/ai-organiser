#!/usr/bin/env node
/**
 * @fileoverview Thompson Sampling bandit for prompt variant selection.
 * v2: Single select() with hierarchical context backoff, UCB cold-start,
 * contextual arms, canonical reward formula with deliberation signal,
 * seedable RNG, and MutexFileStore persistence.
 * @module scripts/bandit
 */

import fs from 'fs';
import path from 'path';
import { MutexFileStore } from './lib/file-store.mjs';
import { createRNG } from './lib/rng.mjs';
import {
  GLOBAL_CONTEXT_BUCKET, normalizeLanguage, learningConfig
} from './lib/config.mjs';

const MIN_BUCKET_SAMPLES = learningConfig.minBucketSamples;
const UCB_MIN_PULLS = learningConfig.ucbMinPulls;

// ── Context Helpers ─────────────────────────────────────────────────────────

/**
 * Canonical context for bandit arm selection.
 * @param {object} repoProfile - From generateRepoProfile()
 * @returns {{ sizeTier: string, dominantLanguage: string }}
 */
export function buildContext(repoProfile) {
  if (!repoProfile) return null;
  return {
    sizeTier: contextSizeTier(repoProfile.totalChars || 0),
    dominantLanguage: normalizeLanguage(repoProfile.dominantLanguage)
  };
}

export function contextSizeTier(charCount) {
  if (charCount < 20_000) return 'small';
  if (charCount < 80_000) return 'medium';
  if (charCount < 300_000) return 'large';
  return 'xlarge';
}

export function contextBucketKey(context) {
  return `${context.sizeTier}:${context.dominantLanguage}`;
}

// ── Prompt Bandit ───────────────────────────────────────────────────────────

export class PromptBandit {
  /**
   * @param {string} statePath
   * @param {object} [options]
   * @param {object} [options.rng] - Injected RNG (for deterministic testing)
   * @param {MutexFileStore} [options.store] - Injected store (for testing)
   */
  constructor(statePath = '.audit/bandit-state.json', options = {}) {
    this.statePath = path.resolve(statePath);
    this._rng = options.rng || createRNG();
    this._store = options.store || new MutexFileStore(this.statePath);
    this.arms = this._store.load();
    if (!this.arms || typeof this.arms !== 'object') this.arms = {};

    // Normalize legacy arms without contextBucket
    for (const arm of Object.values(this.arms)) {
      if (!arm.contextBucket) arm.contextBucket = GLOBAL_CONTEXT_BUCKET;
    }
  }

  /**
   * Register a prompt variant as an arm.
   * @param {string} passName
   * @param {string} variantId
   * @param {string|null} contextBucket - null defaults to GLOBAL
   * @param {object} metadata
   */
  addArm(passName, variantId, contextBucket = null, metadata = {}) {
    const bucket = contextBucket || GLOBAL_CONTEXT_BUCKET;
    const key = `${passName}:${variantId}:${bucket}`;
    if (!this.arms[key]) {
      this.arms[key] = {
        alpha: 1, beta: 1, pulls: 0,
        passName, variantId, contextBucket: bucket,
        ...metadata
      };
      this._save();
    }
  }

  /**
   * Single selection entrypoint with hierarchical backoff.
   * @param {string} passName
   * @param {object|null} context - From buildContext()
   * @returns {object|null} Selected arm
   */
  select(passName, context = null) {
    const exactKey = context ? contextBucketKey(context) : null;
    const sizeKey = context?.sizeTier || null;

    const levels = [
      exactKey ? { bucket: exactKey, label: 'exact' } : null,
      sizeKey ? { bucket: sizeKey, label: 'size' } : null,
      { bucket: GLOBAL_CONTEXT_BUCKET, label: 'global' }
    ].filter(Boolean);

    for (const { bucket } of levels) {
      this._ensureContextArms(passName, bucket);
      const candidates = this._armsForBucket(passName, bucket);
      if (candidates.length > 0 && this._totalPulls(candidates) >= MIN_BUCKET_SAMPLES) {
        return this._selectFromCandidates(candidates);
      }
    }

    // Fallback: global with no sample threshold
    const globalCandidates = this._armsForBucket(passName, GLOBAL_CONTEXT_BUCKET);
    if (globalCandidates.length === 0) return null;
    return this._selectFromCandidates(globalCandidates);
  }

  /**
   * Update arm after observing outcome. Returns false if arm not found.
   * @param {string} passName
   * @param {string} variantId
   * @param {number} reward
   * @param {string} contextBucket
   */
  update(passName, variantId, reward, contextBucket = GLOBAL_CONTEXT_BUCKET) {
    // Validate reward is a finite number to prevent NaN poisoning arm statistics
    if (typeof reward !== 'number' || !isFinite(reward)) {
      process.stderr.write(`  [bandit] WARNING: invalid reward "${reward}" for ${passName}:${variantId} — skipped\n`);
      return false;
    }

    const key = `${passName}:${variantId}:${contextBucket}`;
    const arm = this.arms[key];
    if (!arm) {
      // Try legacy key format (without bucket)
      const legacyKey = `${passName}:${variantId}`;
      const legacyArm = this.arms[legacyKey];
      if (legacyArm) {
        const clampedReward = Math.max(0, Math.min(1, reward));
        legacyArm.alpha += clampedReward;
        legacyArm.beta += (1 - clampedReward);
        legacyArm.pulls++;
        this._save();
        return true;
      }
      process.stderr.write(`  [bandit] WARNING: update called for unknown arm "${key}" — skipped\n`);
      return false;
    }

    const clampedReward = Math.max(0, Math.min(1, reward));
    arm.alpha += clampedReward;
    arm.beta += (1 - clampedReward);
    arm.pulls++;
    this._save();
    return true;
  }

  /** Check if a winning arm has been identified (95% CI separation). */
  hasConverged(passName, contextBucket = GLOBAL_CONTEXT_BUCKET) {
    const candidates = this._armsForBucket(passName, contextBucket);
    if (candidates.length < 2) return true;

    const sorted = [...candidates].sort((a, b) => {
      const aRate = a.alpha / (a.alpha + a.beta);
      const bRate = b.alpha / (b.alpha + b.beta);
      return bRate - aRate;
    });

    const bestArm = sorted[0];
    if (bestArm.pulls < 10) return false;

    const bestMean = bestArm.alpha / (bestArm.alpha + bestArm.beta);
    const bestVar = (bestArm.alpha * bestArm.beta) / ((bestArm.alpha + bestArm.beta) ** 2 * (bestArm.alpha + bestArm.beta + 1));
    const secondArm = sorted[1];
    const secondMean = secondArm.alpha / (secondArm.alpha + secondArm.beta);
    const secondVar = (secondArm.alpha * secondArm.beta) / ((secondArm.alpha + secondArm.beta) ** 2 * (secondArm.alpha + secondArm.beta + 1));

    return bestMean - 2 * Math.sqrt(bestVar) > secondMean + 2 * Math.sqrt(secondVar);
  }

  /** Get stats for all arms. */
  getStats() {
    return Object.values(this.arms).map(a => ({
      pass: a.passName,
      variant: a.variantId,
      contextBucket: a.contextBucket || GLOBAL_CONTEXT_BUCKET,
      estimatedRate: (a.alpha / (a.alpha + a.beta)).toFixed(3),
      pulls: a.pulls,
      alpha: a.alpha,
      beta: a.beta
    })).sort((a, b) => parseFloat(b.estimatedRate) - parseFloat(a.estimatedRate));
  }

  /**
   * Find arms that reference a specific prompt revision.
   * Used by prompt-registry for reference checks before abandoning.
   */
  armsReferencingRevision(passName, revisionId) {
    return Object.values(this.arms).filter(
      a => a.passName === passName && a.promptRevisionId === revisionId
    );
  }

  /** Force immediate save (call at end of audit). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._store.save(this.arms);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _armsForBucket(passName, bucket) {
    return Object.values(this.arms).filter(
      a => a.passName === passName && (a.contextBucket || GLOBAL_CONTEXT_BUCKET) === bucket
    );
  }

  _totalPulls(candidates) {
    return candidates.reduce((sum, a) => sum + a.pulls, 0);
  }

  /**
   * Ensure all known variants have arms at the given context level.
   * Called lazily at selection time, not at arm registration time.
   */
  _ensureContextArms(passName, bucket) {
    if (bucket === GLOBAL_CONTEXT_BUCKET) return;
    const globalArms = this._armsForBucket(passName, GLOBAL_CONTEXT_BUCKET);
    let added = false;
    for (const arm of globalArms) {
      const key = `${passName}:${arm.variantId}:${bucket}`;
      if (!this.arms[key]) {
        this.arms[key] = {
          alpha: 1, beta: 1, pulls: 0,
          passName, variantId: arm.variantId,
          contextBucket: bucket,
          promptRevisionId: arm.promptRevisionId,
          ...(arm.metadata || {})
        };
        added = true;
      }
    }
    // Persist lazily-created arms so they survive across processes
    if (added) this._store.save(this.arms);
  }

  /**
   * Select from candidate arms using cold-start exploration + Thompson Sampling.
   * Cold-start: any arm with < UCB_MIN_PULLS gets forced via UCB1.
   * After warm-up: pure Thompson Sampling.
   */
  _selectFromCandidates(candidates) {
    if (candidates.length <= 1) return candidates[0] ?? null;

    const totalPulls = candidates.reduce((sum, a) => sum + a.pulls, 0);

    // Cold-start: select ONLY from underexplored arms
    const underexplored = candidates.filter(a => a.pulls < UCB_MIN_PULLS);
    if (underexplored.length > 0) {
      let best = null, bestUcb = -1;
      for (const arm of underexplored) {
        const mean = arm.alpha / (arm.alpha + arm.beta);
        const exploration = arm.pulls === 0
          ? Infinity
          : Math.sqrt(2 * Math.log(totalPulls + 1) / arm.pulls);
        const ucb = mean + exploration;
        if (ucb > bestUcb) { bestUcb = ucb; best = arm; }
      }
      return best;
    }

    // Thompson Sampling (uses injected RNG)
    let best = null, bestSample = -1;
    for (const arm of candidates) {
      const sample = this._rng.beta(arm.alpha, arm.beta);
      if (sample > bestSample) { bestSample = sample; best = arm; }
    }
    return best;
  }

  _save() {
    // Debounce: defer write by 100ms to coalesce rapid updates from parallel passes
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._store.save(this.arms);
    }, 100);
  }
}

// ── Canonical Reward Formula ────────────────────────────────────────────────

/**
 * Canonical per-finding reward formula.
 * Components: procedural (40%) + substantive (30%) + deliberation quality (30%).
 * @param {object} resolution - Deliberation resolution
 * @param {object} [evaluationRecord] - PassEvaluationRecord with findingEditLinks
 * @returns {number} Reward in [0, 1]
 */
export function computeReward(resolution, evaluationRecord = null) {
  const positionWeights = { accept: 1.0, partial_accept: 0.6, challenge: 0.0 };
  const rulingWeights = { sustain: 1.0, compromise: 0.5, overrule: 0.0 };
  const severityMult = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };

  const sevMult = severityMult[resolution.final_severity] ?? 0;

  // 1. Procedural signal (40%)
  const procedural = (
    (positionWeights[resolution.claude_position] ?? 0) * 0.4 +
    (rulingWeights[resolution.gpt_ruling] ?? 0) * 0.6
  ) * sevMult;

  // 2. Substantive signal (30%) — verification-gated from finding-edit-links
  let substantive = 0;
  if (evaluationRecord) {
    const link = evaluationRecord.findingEditLinks?.find(
      l => l.semanticHash === resolution.semanticHash
    );
    const remediationReward = {
      verified: 1.0, fixed: 0.7, planned: 0.5, pending: 0.0, regressed: 0.0
    };
    const changeBonus = remediationReward[link?.remediationState] ?? 0.0;
    substantive = changeBonus * sevMult;
  }

  // 3. Deliberation quality signal (30%)
  const deliberation = deliberationSignal(resolution);

  return procedural * 0.4 + substantive * 0.3 + deliberation * 0.3;
}

/**
 * Extract deliberation quality signal from the Claude-GPT exchange.
 * Higher = finding prompted substantive technical discussion.
 * Lower = trivially dismissed or rubber-stamped.
 */
export function deliberationSignal(resolution) {
  let signal = 0.5;

  if (resolution.claude_position === 'challenge' && resolution.gpt_ruling === 'sustain') {
    signal += 0.3;
  }
  if (resolution.gpt_ruling === 'compromise') {
    signal += 0.15;
  }
  if (resolution.claude_position === 'accept' && resolution.gpt_ruling === 'sustain') {
    signal -= 0.1;
  }
  if (resolution.ruling_rationale && resolution.ruling_rationale.length > 200) {
    signal += 0.1;
  }

  return Math.max(0, Math.min(1, signal));
}

/**
 * Compute per-pass reward: simple mean of per-finding rewards.
 * Severity weighting is already applied ONCE inside computeReward() —
 * do NOT apply it again here to avoid double-weighting.
 */
export function computePassReward(evaluationRecord) {
  const rewards = (evaluationRecord.findingEditLinks || [])
    .map(l => l.reward ?? 0);

  if (rewards.length === 0) return 0;
  return rewards.reduce((sum, r) => sum + r, 0) / rewards.length;
}

// ── CLI interface ───────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('bandit.mjs')) {
  const cmd = process.argv[2];
  const bandit = new PromptBandit();

  if (cmd === 'add') {
    const pass = process.argv[3];
    const variant = process.argv[4];
    if (!pass || !variant) {
      console.log('Usage: node scripts/bandit.mjs add <pass-name> <variant-id>');
      process.exit(1);
    }
    bandit.addArm(pass, variant);
    bandit.flush();
    console.log(`Registered arm: ${pass}:${variant}`);
    process.exit(0);
  }

  if (cmd === 'stats') {
    const stats = bandit.getStats();
    if (stats.length === 0) {
      console.log('No bandit arms registered. Arms are created when prompt variants are used.');
    } else {
      console.log('Arm                          | Rate  | Pulls | Bucket  | Converged');
      console.log('-'.repeat(72));
      for (const s of stats) {
        const converged = bandit.hasConverged(s.pass, s.contextBucket) ? 'Y' : '';
        console.log(`${(s.pass+':'+s.variant).padEnd(29)}| ${s.estimatedRate} | ${String(s.pulls).padStart(5)} | ${(s.contextBucket || 'global').padEnd(8)}| ${converged}`);
      }
    }
  } else {
    console.log('Usage: node scripts/bandit.mjs stats');
    console.log('       node scripts/bandit.mjs add <pass-name> <variant-id>');
  }
}
