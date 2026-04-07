/**
 * @fileoverview Finding-related operations: hashing, formatting, outcome logging,
 * effectiveness tracking, false-positive learning (v2 — structured dimensions,
 * lazy-decay EMA, multi-scope counters), remediation tasks, and canonical EWR.
 * @module scripts/lib/findings
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, normalizePath } from './file-io.mjs';
import { MutexFileStore, AppendOnlyStore, readJsonlFile, acquireLock, releaseLock } from './file-store.mjs';
import {
  GLOBAL_REPO_ID, UNKNOWN_FILE_EXT, learningConfig
} from './config.mjs';

// ── Module-level state ─────────────────────────────────────────────────────

let _repoProfileCache = null;

/**
 * Allow the context module to inject the repo-profile cache so that
 * appendOutcome() can stamp each record with a repo fingerprint.
 * @param {object|null} cache
 */
export function setRepoProfileCache(cache) {
  _repoProfileCache = cache;
}

// ── Semantic Hashing ───────────────────────────────────────────────────────

/**
 * Content-addressable finding ID — deterministic, model-agnostic.
 * Same issue keeps the same ID regardless of which model raised it.
 *
 * Phase C: dispatches on `classification.sourceKind`. Tool findings (LINTER,
 * TYPE_CHECKER) use `file:rule:message` identity — stable across line-number
 * shifts when unrelated lines are added above. Model findings keep the
 * original content-hash identity.
 *
 * KNOWN LIMITATION: tool and model findings about the same defect produce
 * DIFFERENT semantic IDs by design — forcing cross-source equivalence is
 * deferred to v2. The prompt's lint-summary tells GPT not to re-raise.
 *
 * @param {object} f - Finding with category, section, detail (+ optional classification)
 * @returns {string} 8-char hex hash
 */
export function semanticId(f) {
  const kind = f.classification?.sourceKind;
  if (kind === 'LINTER' || kind === 'TYPE_CHECKER') {
    const [file] = (f.section || '').split(':');
    const rule = f.principle || 'unknown';
    const msgSnippet = (f.detail || '').slice(0, 60).toLowerCase().trim();
    return crypto.createHash('sha256')
      .update(`${normalizePath(file)}|${rule}|${msgSnippet}`)
      .digest('hex')
      .slice(0, 8);
  }
  const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format findings as readable markdown.
 * @param {object[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  const groups = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const f of findings) (groups[f.severity] ?? groups.LOW).push(f);

  let output = '';
  for (const [sev, items] of Object.entries(groups)) {
    if (!items.length) continue;
    output += `\n### ${sev} Severity\n\n`;
    for (const f of items) {
      output += `#### [${f.id}] ${f.category}: ${f.section}\n`;
      output += `- **Detail**: ${f.detail}\n`;
      if (sev !== 'LOW') {
        output += `- **Risk**: ${f.risk}\n`;
        output += `- **Principle**: ${f.principle}\n`;
      }
      output += `- **Recommendation**: ${f.recommendation}\n`;
      if (f.is_quick_fix) output += `- **WARNING**: Quick fix — needs proper sustainable solution\n`;
      output += '\n';
    }
  }
  return output;
}

// ── Phase 3: Local Outcome Logging ─────────────────────────────────────────

/**
 * Append an audit outcome to the local outcomes log.
 * @param {string} logPath - Path to outcomes.jsonl (default: .audit/outcomes.jsonl)
 * @param {object} outcome - Outcome record
 */
export function appendOutcome(logPath, outcome) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  // Use AppendOnlyStore for consistent lock discipline (shared lock with compactOutcomes)
  const store = new AppendOnlyStore(absPath);
  try {
    store.append({
      ...outcome,
      timestamp: Date.now(),
      repoFingerprint: _repoProfileCache?.repoFingerprint || 'unknown'
    });
  } catch (err) {
    process.stderr.write(`  [outcomes] Failed to log: ${err.message}\n`);
  }
}

/**
 * Load outcomes — pure read, no side effects.
 * Legacy entries without timestamps get _importedAt assigned IN MEMORY only.
 * Call compactOutcomes() separately for persistent backfill + pruning.
 * @param {string} logPath
 * @returns {object[]}
 */
export function loadOutcomes(logPath) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  // Use shared JSONL parser for consistent error recovery (valid lines preserved, bad lines skipped)
  const outcomes = readJsonlFile(absPath);

  const now = Date.now();
  for (const o of outcomes) {
    if (!o.timestamp && !o._importedAt) {
      o._importedAt = now; // In-memory only — not persisted
    }
  }
  return outcomes;
}

/**
 * Compact outcomes file: backfill _importedAt + prune stale entries.
 * Runs under MutexFileStore lock to prevent concurrent corruption.
 * @param {string} logPath
 * @param {object} options
 */
export function compactOutcomes(logPath, options = {}) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  const {
    maxAgeMs = learningConfig.outcomeMaxAgeMs,
    pruneEnabled = learningConfig.outcomePruneEnabled
  } = options;

  const lockPath = absPath + '.lock';
  acquireLock(lockPath);
  try {
    const outcomes = readJsonlFile(absPath);
    const now = Date.now();
    let backfilled = 0;

    for (const o of outcomes) {
      if (!o.timestamp && !o._importedAt) {
        o._importedAt = now;
        backfilled++;
      }
    }

    let fresh = outcomes;
    if (pruneEnabled) {
      fresh = outcomes.filter(o => {
        const ts = o.timestamp || o._importedAt || now;
        return (now - ts) < maxAgeMs;
      });
    }

    const pruned = outcomes.length - fresh.length;
    if (backfilled > 0 || pruned > 0) {
      atomicWriteFileSync(absPath, fresh.map(o => JSON.stringify(o)).join('\n') + '\n');
      if (backfilled > 0) process.stderr.write(`  [outcomes] Backfilled ${backfilled} legacy entries with _importedAt\n`);
      if (pruned > 0) process.stderr.write(`  [outcomes] Pruned ${pruned} stale entries\n`);
    }
  } finally {
    releaseLock(lockPath);
  }
}

// ── Phase 4: Effectiveness Tracking ────────────────────────────────────────

/**
 * Compute pass effectiveness with exponential time decay.
 * @param {object[]} outcomes - From loadOutcomes()
 * @param {string} passName - Optional filter by pass
 * @param {object} options
 * @returns {object} Effectiveness metrics
 */
export function computePassEffectiveness(outcomes, passName = null, options = {}) {
  const {
    halfLifeMs = learningConfig.outcomeHalfLifeMs,
    maxAgeMs = learningConfig.outcomeMaxAgeMs
  } = options;

  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;

  let filtered = passName ? outcomes.filter(o => o.pass === passName) : outcomes;

  filtered = filtered.filter(o => {
    const ts = o.timestamp || o._importedAt || now;
    return (now - ts) < maxAgeMs;
  });

  if (filtered.length === 0) return { acceptanceRate: 0, signalScore: 0, total: 0, accepted: 0, dismissed: 0, effectiveWeight: 0 };

  let weightedAccepted = 0, weightedTotal = 0;
  let accepted = 0, dismissed = 0;

  for (const o of filtered) {
    const ts = o.timestamp || o._importedAt || now;
    const age = now - ts;
    const weight = Math.exp(-lambda * age);
    weightedTotal += weight;
    if (o.accepted) { weightedAccepted += weight; accepted++; }
    else dismissed++;
  }

  return {
    acceptanceRate: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    signalScore: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    total: filtered.length,
    accepted,
    dismissed,
    effectiveWeight: weightedTotal
  };
}

/**
 * Canonical pass quality metric: Expected Weighted Reward (EWR).
 * Used by bandit updates, evolveWorstPass(), convergence, promotion decisions.
 * @param {object[]} outcomes
 * @param {string} passName
 * @param {object} options
 * @returns {{ ewr: number, confidence: number, n: number }}
 */
export function computePassEWR(outcomes, passName, options = {}) {
  const { halfLifeMs = learningConfig.outcomeHalfLifeMs } = options;
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;

  const passOutcomes = outcomes.filter(o => o.pass === passName && o.reward != null);
  if (passOutcomes.length === 0) return { ewr: 0, confidence: 0, n: 0 };

  let weightedRewardSum = 0, weightSum = 0;
  for (const o of passOutcomes) {
    const ts = o.timestamp || o._importedAt || now;
    const weight = Math.exp(-lambda * (now - ts));
    weightedRewardSum += o.reward * weight;
    weightSum += weight;
  }

  const ewr = weightSum > 0 ? weightedRewardSum / weightSum : 0;
  const confidence = Math.min(1, weightSum / 10);

  return { ewr, confidence, n: passOutcomes.length };
}

// ── Lazy-Decay Model ───────────────────────────────────────────────────────

/**
 * Apply lazy decay to a pattern's weights — PURE FUNCTION.
 * Returns a new decayed view without mutating the input.
 * @param {object} pattern
 * @param {number} halfLifeMs
 * @returns {object} Decayed copy
 */
export function applyLazyDecay(pattern, halfLifeMs = learningConfig.outcomeHalfLifeMs) {
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;
  const elapsed = now - (pattern.lastDecayTs || now);

  const dA = pattern.decayedAccepted || 0;
  const dD = pattern.decayedDismissed || 0;

  if (elapsed <= 0) {
    const total = dA + dD;
    return { ...pattern, ema: total > 0 ? dA / total : 0.5 };
  }

  const decay = Math.exp(-lambda * elapsed);
  const decayedAccepted = dA * decay;
  const decayedDismissed = dD * decay;
  const total = decayedAccepted + decayedDismissed;

  return {
    ...pattern,
    decayedAccepted,
    decayedDismissed,
    lastDecayTs: now,
    ema: total > 0 ? decayedAccepted / total : 0.5
  };
}

/**
 * Effective sample size: sum of decayed weights.
 */
export function effectiveSampleSize(pattern) {
  return (pattern.decayedAccepted || 0) + (pattern.decayedDismissed || 0);
}

/**
 * Record an observation with lazy decay.
 * Mutates the pattern in place (for persistence).
 */
export function recordWithDecay(pattern, accepted, halfLifeMs = learningConfig.outcomeHalfLifeMs) {
  const decayed = applyLazyDecay(pattern, halfLifeMs);

  if (accepted) {
    decayed.decayedAccepted += 1.0;
    decayed.accepted = (pattern.accepted || 0) + 1;
  } else {
    decayed.decayedDismissed += 1.0;
    decayed.dismissed = (pattern.dismissed || 0) + 1;
  }

  const total = decayed.decayedAccepted + decayed.decayedDismissed;
  decayed.ema = total > 0 ? decayed.decayedAccepted / total : 0.5;
  decayed.lastUpdated = Date.now();

  Object.assign(pattern, decayed);
}

// ── FP Pattern Key Helpers ─────────────────────────────────────────────────

/**
 * Extract structured dimensions from a finding.
 */
export function extractDimensions(finding, repoFingerprint = null, filePath = null) {
  const category = (finding.category || '').replace(/\[.*?\]\s*/g, '').trim().toLowerCase();
  const principle = (finding.principle || 'unknown').toLowerCase();
  const severity = finding.severity || 'UNKNOWN';
  const repoId = repoFingerprint || GLOBAL_REPO_ID;
  const fileExtension = filePath ? path.extname(filePath).replace('.', '').toLowerCase() || UNKNOWN_FILE_EXT : UNKNOWN_FILE_EXT;

  return { category, severity, principle, repoId, fileExtension };
}

/**
 * Build a pattern key from structured dimensions + scope.
 */
export function buildPatternKey(dims) {
  return `${dims.category}::${dims.severity}::${dims.principle}::${dims.repoId}::${dims.fileExtension}::${dims.scope}`;
}

// ── False Positive Tracker (v2) ────────────────────────────────────────────

/**
 * False positive tracker with structured dimensions, multi-scope counters,
 * and lazy-decay EMA. Auto-suppresses patterns with consistently high dismiss rates.
 */
export class FalsePositiveTracker {
  /**
   * @param {string} statePath
   * @param {object} [options]
   * @param {MutexFileStore} [options.store] - Injected store (for testing)
   */
  constructor(statePath = '.audit/fp-tracker.json', options = {}) {
    this.statePath = path.resolve(statePath);
    this._store = options.store || new MutexFileStore(this.statePath);
    this.patterns = this._store.load();
    if (!this.patterns || typeof this.patterns !== 'object') this.patterns = {};
  }

  /** Generate a legacy-compatible pattern key from a finding. */
  patternKey(finding) {
    const category = (finding.category || '').replace(/\[.*?\]\s*/g, '').trim().toLowerCase();
    const principle = (finding.principle || 'unknown').toLowerCase();
    return `${category}::${finding.severity || 'UNKNOWN'}::${principle}`;
  }

  /**
   * Record outcome with structured dimensions at all 3 scope levels.
   * Falls back to legacy single-key if no repo context is provided.
   */
  record(finding, accepted, repoFingerprint = null, filePath = null) {
    if (!repoFingerprint) {
      // Legacy path — single global-scope key with lazy decay
      const key = this.patternKey(finding);
      if (!this.patterns[key]) {
        this.patterns[key] = {
          dismissed: 0, accepted: 0, ema: 0.5,
          decayedAccepted: 0, decayedDismissed: 0,
          lastDecayTs: Date.now(), scope: 'global',
          repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT,
          firstSeen: Date.now(), lastUpdated: Date.now()
        };
      }
      recordWithDecay(this.patterns[key], accepted);
      this._store.save(this.patterns);
      return;
    }

    // v2 path — update all 3 scope levels
    const dims = extractDimensions(finding, repoFingerprint, filePath);
    const scopes = [
      { ...dims, scope: 'repo+fileType' },
      { ...dims, fileExtension: UNKNOWN_FILE_EXT, scope: 'repo' },
      { ...dims, repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT, scope: 'global' }
    ];

    for (const scopeDims of scopes) {
      const key = buildPatternKey(scopeDims);
      if (!this.patterns[key]) {
        this.patterns[key] = {
          ...scopeDims,
          dismissed: 0, accepted: 0, ema: 0.5,
          decayedAccepted: 0, decayedDismissed: 0,
          lastDecayTs: Date.now(),
          firstSeen: Date.now(), lastUpdated: Date.now()
        };
      }
      recordWithDecay(this.patterns[key], accepted);
    }

    this._store.save(this.patterns);
  }

  /**
   * Should this finding pattern be auto-suppressed?
   * Hierarchical with confidence-aware override.
   */
  shouldSuppress(finding, repoFingerprint = null, filePath = null) {
    const MIN_FP_SAMPLES = learningConfig.minFpSamples;

    if (repoFingerprint) {
      const dims = extractDimensions(finding, repoFingerprint, filePath);
      const scopeChecks = [
        { ...dims, scope: 'repo+fileType' },
        { ...dims, fileExtension: UNKNOWN_FILE_EXT, scope: 'repo' },
        { ...dims, repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT, scope: 'global' }
      ];

      for (const scopeDims of scopeChecks) {
        const key = buildPatternKey(scopeDims);
        const p = this.patterns[key];
        if (!p) continue;

        const decayed = applyLazyDecay(p);
        const ess = effectiveSampleSize(decayed);
        if (ess < MIN_FP_SAMPLES) continue;

        return decayed.ema < 0.15;
      }
    }

    // Legacy fallback
    const p = this.patterns[this.patternKey(finding)];
    if (!p) return false;
    const decayed = applyLazyDecay(p);
    const ess = effectiveSampleSize(decayed);
    if (ess < MIN_FP_SAMPLES) {
      // Fall back to raw counts for legacy patterns without decay fields
      const total = (p.accepted || 0) + (p.dismissed || 0);
      return total >= 5 && (p.ema ?? 0.5) < 0.15;
    }
    return decayed.ema < 0.15;
  }

  /** Get suppression report for all tracked patterns. */
  getReport() {
    return Object.entries(this.patterns)
      .map(([key, p]) => {
        const decayed = applyLazyDecay(p);
        const ess = effectiveSampleSize(decayed);
        return {
          pattern: key,
          scope: p.scope || 'global',
          total: (p.accepted || 0) + (p.dismissed || 0),
          effectiveSampleSize: ess,
          acceptRate: decayed.ema,
          suppressed: ess >= learningConfig.minFpSamples && decayed.ema < 0.15
        };
      })
      .sort((a, b) => a.acceptRate - b.acceptRate);
  }
}

// ── Remediation Tasks ──────────────────────────────────────────────────────

/**
 * Create a RemediationTask at adjudication time.
 * @param {string} runId
 * @param {string} passName
 * @param {object} finding - Must have semanticHash, findingId (id), severity
 * @returns {object} RemediationTask
 */
export function createRemediationTask(runId, passName, finding) {
  return {
    taskId: `${runId}-${passName}-${finding.semanticHash || semanticId(finding)}`,
    runId,
    passName,
    semanticHash: finding.semanticHash || semanticId(finding),
    findingId: finding.id || finding.findingId,
    severity: finding.severity,
    remediationState: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    edits: []
  };
}

/**
 * Append an edit to a task (called during fix generation).
 */
export function trackEdit(task, edit) {
  task.edits.push({ ...edit, timestamp: Date.now() });
  task.remediationState = 'fixed';
  task.updatedAt = Date.now();
}

/**
 * Update task after verification step.
 */
export function verifyTask(task, verifiedBy, passed) {
  task.remediationState = passed ? 'verified' : 'regressed';
  task.verifiedBy = verifiedBy;
  task.verifiedAt = Date.now();
  task.updatedAt = Date.now();
}

// ── Remediation Task Persistence ───────────────────────────────────────────

let _taskStore = null;

function getTaskStore() {
  if (!_taskStore) {
    _taskStore = new AppendOnlyStore('.audit/remediation-tasks.jsonl');
  }
  return _taskStore;
}

/** Create and persist a new task. */
export function persistTask(task) { getTaskStore().append(task); }

/** Load all tasks, optionally filtered by runId. */
export function loadTasks(runId = null) {
  const all = getTaskStore().loadAll();
  // Latest version of each task wins (append-only, keyed by taskId)
  const byId = new Map();
  for (const t of all) byId.set(t.taskId, t);
  const tasks = [...byId.values()];
  return runId ? tasks.filter(t => t.runId === runId) : tasks;
}

/** Update a task (append new version). */
export function updateTask(task) {
  task.updatedAt = Date.now();
  getTaskStore().append(task);
}
