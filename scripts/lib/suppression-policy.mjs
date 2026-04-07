/**
 * @fileoverview Unified R2+ suppression policy — single source of truth for all
 * suppression decisions. Feeds all three layers (system-prompt exclusions,
 * R2+ prompt augmentation, post-output suppression) from one resolved policy.
 * @module scripts/lib/suppression-policy
 */

import { learningConfig, GLOBAL_REPO_ID, UNKNOWN_FILE_EXT } from './config.mjs';

const MIN_FP_SAMPLES = learningConfig.minFpSamples;

// ── Lazy Decay Helpers ──────────────────────────────────────────────────────

/**
 * Effective sample size: sum of decayed weights.
 * Used for confidence-aware scope resolution.
 */
export function effectiveSampleSize(pattern) {
  return (pattern.decayedAccepted || 0) + (pattern.decayedDismissed || 0);
}

// ── Policy Resolution ───────────────────────────────────────────────────────

/**
 * Build ledger exclusions from adjudication ledger entries.
 */
function buildLedgerExclusions(ledger) {
  if (!ledger?.entries) return [];
  return ledger.entries
    .filter(e => e.adjudicationOutcome === 'dismissed')
    .map(e => ({
      topicId: e.topicId,
      semanticHash: e.semanticHash,
      category: e.category,
      severity: e.severity,
      principle: e.affectedPrinciples?.[0],
      section: e.section
    }));
}

/**
 * Resolve FP patterns from local tracker + cloud patterns.
 * Applies lazy decay to get current effective sample sizes.
 */
function resolveFpPatterns(fpTracker, cloudPatterns, repoFingerprint) {
  const patterns = [];

  // Local patterns
  if (fpTracker?.patterns) {
    for (const [key, p] of Object.entries(fpTracker.patterns)) {
      patterns.push({
        ...p,
        _key: key,
        scope: p.scope || 'global',
        repoId: p.repoId || GLOBAL_REPO_ID,
        fileExtension: p.fileExtension || UNKNOWN_FILE_EXT
      });
    }
  }

  // Cloud patterns (already have structured dimensions)
  if (cloudPatterns) {
    for (const cp of [...(cloudPatterns.repoPatterns || []), ...(cloudPatterns.globalPatterns || [])]) {
      // Avoid duplicates — cloud patterns supplement local
      const existing = patterns.find(p =>
        p.category === cp.category && p.severity === cp.severity &&
        p.principle === cp.principle && p.scope === cp.scope
      );
      if (!existing) {
        patterns.push({
          ...cp,
          _key: `${cp.category}::${cp.severity}::${cp.principle}`,
          decayedAccepted: cp.decayed_accepted ?? cp.decayedAccepted ?? 0,
          decayedDismissed: cp.decayed_dismissed ?? cp.decayedDismissed ?? 0
        });
      }
    }
  }

  return patterns;
}

/**
 * Deduplicate exclusions from ledger and FP patterns.
 */
function deduplicateExclusions(ledgerExclusions, fpPatterns) {
  const seen = new Set();
  const result = [];

  for (const e of ledgerExclusions) {
    const key = `${e.category}::${e.severity}::${e.principle || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }

  for (const p of fpPatterns) {
    const ess = effectiveSampleSize(p);
    if (ess >= MIN_FP_SAMPLES && (p.ema ?? 0.5) < 0.15) {
      const key = `${p.category}::${p.severity}::${p.principle || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          topicId: p._key || `fp:${p.category}:${p.severity}`,
          category: p.category,
          severity: p.severity,
          principle: p.principle,
          scope: p.scope
        });
      }
    }
  }

  return result;
}

/**
 * Check if a finding matches a pattern/exclusion.
 */
function matchesFinding(pattern, finding) {
  const fCat = (finding.category || '').replace(/\[.*?\]\s*/g, '').trim().toLowerCase();
  const pCat = (pattern.category || '').toLowerCase();
  const fPrin = (finding.principle || '').toLowerCase();
  const pPrin = (pattern.principle || '').toLowerCase();
  return fCat === pCat && (finding.severity || '') === (pattern.severity || '') &&
    (!pPrin || !fPrin || fPrin === pPrin);
}

/**
 * Resolve suppression policy from all sources.
 * Called once at audit start, result feeds all three R2+ layers.
 * @param {object} ledger - Adjudication ledger
 * @param {object} fpTracker - FalsePositiveTracker instance
 * @param {object} cloudPatterns - From loadFalsePositivePatterns()
 * @param {string} repoFingerprint
 * @returns {object} Resolved policy
 */
export function resolveSuppressionPolicy(ledger, fpTracker, cloudPatterns, repoFingerprint) {
  const ledgerExclusions = buildLedgerExclusions(ledger);
  const fpSuppressions = resolveFpPatterns(fpTracker, cloudPatterns, repoFingerprint);

  const systemPromptExclusions = deduplicateExclusions(ledgerExclusions, fpSuppressions);
  const suppressionTopics = new Set([
    ...ledgerExclusions.map(e => e.topicId),
    ...fpSuppressions
      .filter(p => effectiveSampleSize(p) >= MIN_FP_SAMPLES && (p.ema ?? 0.5) < 0.15)
      .map(p => p._key)
  ]);

  return {
    ledgerExclusions,
    fpSuppressions,
    systemPromptExclusions,
    suppressionTopics
  };
}

/**
 * Format policy for system prompt injection (Layer 1).
 * @param {object} policy
 * @returns {string}
 */
export function formatPolicyForPrompt(policy) {
  if (!policy.systemPromptExclusions.length) return '';
  const lines = policy.systemPromptExclusions.map(e =>
    `- Do NOT raise: "${e.category}" (${e.severity}) — previously dismissed`
  );
  return '\n\nKNOWN FALSE POSITIVES (do NOT re-raise these):\n' + lines.join('\n');
}

/**
 * Check a finding against the policy (Layer 3 post-output).
 * Confidence-aware: narrower scopes only override broader when they have enough evidence.
 * @param {object} finding
 * @param {object} policy
 * @returns {{ suppress: boolean, scope: string, confidence: number, reason: string }}
 */
export function shouldSuppressFinding(finding, policy) {
  // Check FP patterns with hierarchical scope resolution
  for (const scope of ['repo+fileType', 'repo', 'global']) {
    const match = policy.fpSuppressions.find(p =>
      p.scope === scope && matchesFinding(p, finding)
    );
    if (!match) continue;

    const ess = effectiveSampleSize(match);
    if (ess < MIN_FP_SAMPLES) continue;

    if ((match.ema ?? 0.5) < 0.15) {
      return {
        suppress: true,
        scope,
        confidence: Math.min(1, ess / 10),
        reason: `FP pattern (${scope}, n=${ess.toFixed(1)}, ema=${(match.ema ?? 0).toFixed(2)})`
      };
    }

    // Scope has enough data but doesn't suppress — stop checking broader scopes
    return { suppress: false, scope, confidence: 0, reason: 'Pattern exists but above threshold' };
  }

  // No FP pattern match — check ledger exclusions
  const ledgerMatch = policy.ledgerExclusions.find(e => matchesFinding(e, finding));
  if (ledgerMatch) {
    return { suppress: true, scope: 'ledger', confidence: 1, reason: `Ledger exclusion: ${ledgerMatch.topicId}` };
  }

  return { suppress: false, scope: 'none', confidence: 0, reason: 'No matching pattern' };
}
