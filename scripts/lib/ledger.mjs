/**
 * Adjudication ledger and R2+ suppression logic.
 *
 * Extracted from shared.mjs — handles ledger read/write, finding metadata,
 * fuzzy suppression of re-raised findings, and Round 2+ prompt construction.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { normalizePath, atomicWriteFileSync } from './file-io.mjs';
import { LedgerEntrySchema, AdjudicationLedgerSchema } from './schemas.mjs';
import { semanticId } from './findings.mjs';
import { buildFileReferenceRegex } from './language-profiles.mjs';

// Single source of truth — regex built from registered profile extensions.
// Handles ./foo.py, ../pkg/mod.py, /abs/foo.py, backticked, quoted forms.
// Global regex, so callers must reset .lastIndex before use.
const FILE_REGEX = buildFileReferenceRegex();

// ── Topic ID & Ledger Write ─────────────────────────────────────────────────

/**
 * Deterministic fingerprint from structured fields. No content hash (stable across rewordings).
 * @param {object} finding - Finding object with section, principle, category, _pass fields
 * @returns {string} 12-char hex topic ID
 */
export function generateTopicId(finding) {
  const normFile = normalizePath(finding._primaryFile || finding.section?.split(':')[0] || 'unknown');
  const normPrinciple = (finding.principle || 'unknown').split('/')[0].split('—')[0].trim().toLowerCase().replace(/\s+/g, '-');
  const normCategory = (finding.category || 'unknown').replace(/\[.*?\]\s*/g, '').trim().toLowerCase().replace(/\s+/g, '-');
  const pass = finding._pass || 'unknown';
  // Include semantic hash for disambiguation — prevents collisions when multiple
  // findings share the same file/principle/category/pass combination.
  const contentHash = finding._hash || semanticId(finding);
  const content = `${normFile}|${normPrinciple}|${normCategory}|${pass}|${contentHash}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Upsert a ledger entry by topicId. Read-modify-write (not append).
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object} entry - LedgerEntry-shaped object
 */
export function writeLedgerEntry(ledgerPath, entry) {
  const absPath = path.resolve(ledgerPath);
  let ledger = { version: 1, entries: [] };

  // Validate entry against schema before writing
  const validated = LedgerEntrySchema.safeParse(entry);
  if (!validated.success) {
    process.stderr.write(`  [ledger] Entry validation failed: ${validated.error.message.slice(0, 200)}\n`);
    return; // Refuse to write invalid data
  }
  const validEntry = validated.data;

  // Read existing — fail loudly on corruption rather than silently overwriting
  if (fs.existsSync(absPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const ledgerValidated = AdjudicationLedgerSchema.safeParse(raw);
      if (ledgerValidated.success) {
        ledger = ledgerValidated.data;
      } else {
        // Graceful: accept structurally valid ledgers even if individual entries are slightly off
        if (raw && Array.isArray(raw.entries)) {
          process.stderr.write(`  [ledger] WARNING: ${absPath} has schema warnings — using as-is\n`);
          ledger = raw;
        } else {
          process.stderr.write(`  [ledger] WARNING: ${absPath} has invalid structure — backing up and starting fresh\n`);
          fs.copyFileSync(absPath, `${absPath}.bak`);
        }
      }
    } catch (err) {
      process.stderr.write(`  [ledger] WARNING: ${absPath} corrupted — backing up and starting fresh: ${err.message}\n`);
      try { fs.copyFileSync(absPath, `${absPath}.bak`); } catch { /* ignore */ }
    }
  }

  // Upsert by topicId
  const idx = ledger.entries.findIndex(e => e.topicId === validEntry.topicId);
  if (idx >= 0) {
    ledger.entries[idx] = validEntry;
  } else {
    ledger.entries.push(validEntry);
  }

  // Atomic write — temp file + rename for crash safety
  try {
    atomicWriteFileSync(absPath, JSON.stringify(ledger, null, 2));
  } catch (err) {
    process.stderr.write(`  [ledger] Failed to write ${absPath}: ${err.message}\n`);
  }
}

/**
 * Batch-write ledger entries. Reads existing ledger (if any), upserts all entries
 * by topicId with idempotent merge, performs exactly one atomic write.
 * Only treats ENOENT as 'new file' — permission/corruption errors surface to caller.
 * Preserves both adjudication axes on upsert (adjudicationOutcome + remediationState).
 *
 * Invalid entries are returned in `rejected[]` with a per-entry reason — the caller
 * decides whether to proceed or fail. Never silently drops data.
 *
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object[]} entries - Array of LedgerEntry-shaped objects
 * @returns {{ inserted: number, updated: number, total: number, rejected: Array<{entry:object,reason:string}> }}
 * @throws {Error} on permission errors or corrupt ledger
 */
export function batchWriteLedger(ledgerPath, entries) {
  let ledger = { version: 1, entries: [] };

  try {
    const raw = fs.readFileSync(path.resolve(ledgerPath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      throw new Error('Corrupted ledger: missing entries array');
    }
    ledger = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const byTopic = new Map(ledger.entries.map(e => [e.topicId, e]));
  const rejected = [];
  let inserted = 0, updated = 0;

  for (const entry of entries) {
    if (!entry.topicId) {
      rejected.push({ entry, reason: 'missing topicId' });
      continue;
    }
    if (!entry.severity || !entry.adjudicationOutcome) {
      rejected.push({ entry, reason: 'missing severity or adjudicationOutcome' });
      continue;
    }

    if (byTopic.has(entry.topicId)) {
      const existing = byTopic.get(entry.topicId);
      byTopic.set(entry.topicId, {
        ...existing,
        lastSeenRound: entry.round,
        latestFindingId: entry.findingId,
        detail: entry.detail,
        severity: entry.severity,
        adjudicationOutcome: existing.adjudicationOutcome,
        remediationState: existing.remediationState,
        ruling: existing.ruling,
        rulingRationale: existing.rulingRationale,
        firstSeenRound: existing.firstSeenRound ?? existing.round ?? entry.round
      });
      updated++;
    } else {
      byTopic.set(entry.topicId, {
        ...entry,
        firstSeenRound: entry.round,
        lastSeenRound: entry.round
      });
      inserted++;
    }
  }

  ledger.entries = [...byTopic.values()];
  if (ledger.entries.some(e => !e.topicId)) {
    throw new Error('Ledger integrity check failed: entry without topicId');
  }
  atomicWriteFileSync(path.resolve(ledgerPath), JSON.stringify(ledger, null, 2));
  return { inserted, updated, total: ledger.entries.length, rejected };
}

// ── Finding Metadata ────────────────────────────────────────────────────────

/**
 * Enrich GPT finding with structured fields for suppression matching.
 * @param {object} finding - Raw finding from GPT
 * @param {string} passName - Current pass name
 * @returns {object} Enriched finding (mutated in place)
 */
export function populateFindingMetadata(finding, passName) {
  // Extract file paths from GPT's free-text section field using the shared
  // registry-derived regex (handles .py, .pyi, relative/absolute paths).
  const section = finding.section || '';
  const files = [];
  FILE_REGEX.lastIndex = 0; // reset global regex state between calls
  let match;
  while ((match = FILE_REGEX.exec(section)) !== null) {
    files.push(normalizePath(match[1]));
  }

  finding._primaryFile = files[0] || normalizePath(section.split(':')[0].split('(')[0].trim());
  finding.affectedFiles = files.length > 0 ? files : [finding._primaryFile];
  finding._pass = passName || finding._pass || 'unknown';
  if (!finding.principle) finding.principle = 'unknown';
  // Ensure stable content hash is always present
  if (!finding._hash) finding._hash = semanticId(finding);
  return finding;
}

// ── Fuzzy Suppression ───────────────────────────────────────────────────────

/**
 * Text similarity via token set overlap (Jaccard index).
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score 0-1
 */
export function jaccardSimilarity(a, b) {
  const tokenize = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Three-step suppression: narrow by pass+scope, fuzzy score, reopen check.
 * @param {object[]} findings - Current round findings (with _primaryFile, _pass)
 * @param {object} ledger - Parsed adjudication ledger
 * @param {object} opts
 * @param {string[]} [opts.changedFiles] - Files changed since last round
 * @param {string[]} [opts.impactSet] - Files in the impact set
 * @returns {{kept: object[], suppressed: object[], reopened: object[]}}
 */
export function suppressReRaises(findings, ledger, { changedFiles = [], impactSet = [] } = {}) {
  // Threshold calibrated from real audit data — paraphrased re-raises score 0.3-0.6, new findings <0.2
  const threshold = parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35');

  // Source-aware filter (Phase D fix H2):
  //   session entries suppress when adjudicationOutcome='dismissed' or
  //     remediationState='fixed'|'verified' (existing R2+ behavior)
  //   debt entries (Phase D) suppress unless they're escalated — escalation
  //     naturally bypasses suppression for re-deliberation
  //   Entries without an explicit source default to session (backward compat
  //     for ledger files written before Phase D)
  const resolved = (ledger?.entries || []).filter(e => {
    const src = e.source || 'session';
    if (src === 'debt') return !e.escalated;
    // session (default)
    return e.adjudicationOutcome === 'dismissed' ||
           e.remediationState === 'fixed' ||
           e.remediationState === 'verified';
  });

  const kept = [], suppressed = [], reopened = [];
  const changedSet = new Set(changedFiles.map(normalizePath));

  for (const f of findings) {
    // Step 1: Narrow candidates by pass + file scope overlap
    const fFile = normalizePath(f._primaryFile || f.section || '');
    const candidates = resolved.filter(d =>
      d.pass === f._pass &&
      d.affectedFiles.some(af => normalizePath(af) === fFile || fFile.includes(normalizePath(af)))
    );

    if (candidates.length === 0) { kept.push(f); continue; }

    // Step 2: Score all candidates, pick highest
    let bestMatch = null, bestScore = 0;
    for (const d of candidates) {
      const score = jaccardSimilarity(
        `${f.category} ${f.section} ${f.detail}`,
        `${d.category} ${d.section} ${d.detailSnapshot}`
      );
      if (score > bestScore) { bestScore = score; bestMatch = d; }
    }

    // Step 3: Threshold + reopen check
    if (bestMatch && bestScore > threshold) {
      const scopeDirectlyChanged = bestMatch.affectedFiles.some(af => changedSet.has(normalizePath(af)));
      if (scopeDirectlyChanged) {
        f._reopened = true;
        f._matchedTopic = bestMatch.topicId;
        f._matchScore = bestScore;
        reopened.push(f);
      } else {
        const src = bestMatch.source || 'session';
        const reason = src === 'debt'
          ? `Matches deferred debt entry (${bestMatch.deferredReason}), scope unchanged`
          : `Matches ${bestMatch.adjudicationOutcome} entry, scope unchanged`;
        suppressed.push({
          finding: f,
          matchedTopic: bestMatch.topicId,
          matchScore: bestScore,
          matchedSource: src,
          reason,
        });
      }
    } else {
      kept.push(f);
    }
  }

  return { kept, suppressed, reopened };
}

// ── Rulings Block & R2+ Prompts ─────────────────────────────────────────────

/**
 * Format ledger entries as system-prompt exclusions for a specific pass.
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {string} passName - Current pass name
 * @param {string[]} [impactSet] - Files in the impact set
 * @returns {string} Formatted rulings block for system prompt
 */
export function buildRulingsBlock(ledgerPath, passName, impactSet = []) {
  if (!ledgerPath) return '';
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [rulings] Ledger not found: ${absPath}\n`);
    return '';
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [rulings] Failed to parse ledger: ${err.message}\n`);
    return '';
  }

  const entries = (ledger.entries || []).filter(e => e.pass === passName);
  if (entries.length === 0) return '';

  // Group by outcome
  const dismissed = entries.filter(e => e.adjudicationOutcome === 'dismissed');
  const adjusted = entries.filter(e => e.adjudicationOutcome === 'severity_adjusted');
  const fixed = entries.filter(e => e.remediationState === 'fixed' || e.remediationState === 'verified');

  const lines = [
    '## YOUR PRIOR RULINGS (scoped to this pass)',
    '',
    'These items were deliberated in prior rounds. Do NOT re-raise them unless',
    'the code they affect has materially changed (in which case mark as REOPENED).',
    ''
  ];

  if (dismissed.length > 0) {
    lines.push('### DISMISSED');
    for (const d of dismissed.slice(0, 8)) {
      lines.push(`- [${d.topicId.slice(0,6)}] "${d.category}" — YOU ruled DISMISSED R${d.resolvedRound}. Reason: ${d.rulingRationale.slice(0, 100)}. Scope: ${d.affectedFiles.join(', ')}`);
    }
    if (dismissed.length > 8) lines.push(`  ... and ${dismissed.length - 8} more dismissed items`);
    lines.push('');
  }

  if (adjusted.length > 0) {
    lines.push('### SEVERITY ADJUSTED (do not re-escalate)');
    for (const a of adjusted.slice(0, 5)) {
      lines.push(`- [${a.topicId.slice(0,6)}] "${a.category}" — ${a.originalSeverity}→${a.severity} R${a.resolvedRound}. Scope: ${a.affectedFiles.join(', ')}`);
    }
    lines.push('');
  }

  if (fixed.length > 0) {
    lines.push('### FIXED (do not re-raise)');
    for (const f of fixed.slice(0, 5)) {
      lines.push(`- [${f.topicId.slice(0,6)}] "${f.category}" — FIXED R${f.resolvedRound}. Scope: ${f.affectedFiles.join(', ')}`);
    }
    lines.push('');
  }

  let block = lines.join('\n');
  // Cap at ~1500 chars
  if (block.length > 1500) {
    block = block.slice(0, 1400) + '\n\n... [rulings truncated — see ledger for full list]';
  }

  process.stderr.write(`  [rulings] ${entries.length} entries for pass "${passName}" (${block.length} chars)\n`);
  return block;
}

/** Round 2+ system prompt modifier for verification-focused auditing. */
export const R2_ROUND_MODIFIER = `ROUND 2+ VERIFICATION MODE

This is a follow-up round. Your job has CHANGED from Round 1:

Round 1: Find ALL issues in the codebase.
Round 2+: VERIFY FIXES and CHECK FOR REGRESSIONS.

FOCUS ON:
1. Do the fixes resolve the original findings?
2. Did any fix introduce NEW problems in CHANGED code?
3. Did changes cause KNOCK-ON regressions in code that imports/depends on changed files?
4. Are there genuinely NEW issues not present in Round 1?

DO NOT:
- Re-raise findings from YOUR PRIOR RULINGS section below
- Paraphrase a dismissed finding as "new" — that contradicts your own judgment
- Re-audit unchanged, unaffected code for the same issue classes

If you believe a dismissed finding should be REOPENED because changed code
materially affects its scope, raise it with is_reopened: true.`;

/**
 * Build a Round 2+ system prompt with rulings context and pass rubric.
 * @param {string} passRubric - The pass-specific rubric text
 * @param {string} rulingsBlock - Output of buildRulingsBlock()
 * @returns {string} Complete R2+ system prompt
 */
export function buildR2SystemPrompt(passRubric, rulingsBlock) {
  return `${R2_ROUND_MODIFIER}\n\n${rulingsBlock}\n\n---\n\nPASS RUBRIC (what to check):\n${passRubric}`;
}

// ── Impact Set ──────────────────────────────────────────────────────────────

/**
 * Compute impact set: changed files + files that import them.
 * @param {string[]} changedFiles - Files directly changed
 * @param {string[]} allFiles - All project files to scan for imports
 * @returns {string[]} Sorted list of impacted file paths (normalized)
 */
export function computeImpactSet(changedFiles, allFiles) {
  const impact = new Set(changedFiles.map(normalizePath));

  for (const file of allFiles) {
    const normFile = normalizePath(file);
    if (impact.has(normFile)) continue;

    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');
    for (const changed of changedFiles) {
      const basename = path.basename(changed, path.extname(changed));
      const normChanged = normalizePath(changed);
      if (content.includes(`from './${basename}`) || content.includes(`from './${normChanged}`)) {
        impact.add(normFile);
        break;
      }
    }
  }

  return [...impact].sort();
}
