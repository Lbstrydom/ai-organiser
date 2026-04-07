/**
 * @fileoverview Pure robustness utilities for the audit pipeline.
 * Error classification, payload truncation, finding normalization, ledger path resolution.
 * All functions are side-effect-free and testable in isolation.
 */

import path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
export const MAX_REDUCE_JSON_CHARS = 120_000;
export const MAX_DETAIL_CHARS = 200;
export const MAP_FAILURE_THRESHOLD = 0.5;
export const RETRY_MAX_ATTEMPTS = 1;
export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_429_MAX_DELAY_MS = 8000;
export const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// ── LLM Error Classification ─────────────────────────────────────────────────

/**
 * Structured LLM error — carries usage and category for retry/accounting.
 */
export class LlmError extends Error {
  constructor(message, { category, usage = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.llmCategory = category;
    this.llmUsage = usage;
    this.llmRetryable = retryable;
  }
}

/**
 * Classify an LLM API error into retryable vs permanent categories.
 * Uses structured fields where available, avoids message-string matching.
 */
export function classifyLlmError(err) {
  if (err.llmCategory) return { retryable: err.llmRetryable, category: err.llmCategory };
  if (err.status) {
    if ([429, 500, 502, 503, 504].includes(err.status)) return { retryable: true, category: `http-${err.status}` };
    if (err.status >= 400 && err.status < 500) return { retryable: false, category: `http-${err.status}` };
  }
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { retryable: true, category: 'timeout' };
  if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ENOTFOUND') return { retryable: true, category: 'network' };
  return { retryable: false, category: 'permanent' };
}

// ── Reduce Payload Builder ──────────────────────────────────────────────────

/**
 * Build a budget-safe JSON payload for the REDUCE phase.
 * Owns the sort invariant (HIGH > MEDIUM > LOW, tie-break by id).
 * Drops lowest-severity findings until under budget.
 */
export function buildReducePayload(findings, budget = MAX_REDUCE_JSON_CHARS) {
  const sorted = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });

  const summarize = (f) => ({
    id: f.id, severity: f.severity, category: f.category,
    section: f.section, detail: f.detail?.slice(0, MAX_DETAIL_CHARS),
    is_quick_fix: f.is_quick_fix, _mapUnit: f._mapUnit
  });

  let subset = sorted.map(summarize);
  let json = JSON.stringify(subset, null, 2);

  while (json.length > budget && subset.length > 1) {
    subset.pop();
    json = JSON.stringify(subset, null, 2);
  }

  if (json.length > budget && subset.length === 1) {
    const f = subset[0];
    for (const field of ['detail', 'category', 'section']) {
      if (json.length <= budget) break;
      const maxLen = Math.max(30, (f[field]?.length ?? 0) - (json.length - budget));
      f[field] = f[field]?.slice(0, maxLen);
      subset[0] = { ...f };
      json = JSON.stringify(subset, null, 2);
    }
  }

  if (json.length > budget) {
    return { json: '[]', includedCount: 0, totalCount: findings.length, degraded: true };
  }

  return { json, includedCount: subset.length, totalCount: findings.length, degraded: false };
}

/**
 * Normalize findings for output: semantic dedup, stable sort.
 * Used by both REDUCE output and raw MAP survivors for consistent downstream behavior.
 * @param {Array} findings
 * @param {Function} [semanticIdFn] - Hash function for dedup (defaults to JSON.stringify)
 */
export function normalizeFindingsForOutput(findings, semanticIdFn) {
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const hash = f._hash || (semanticIdFn ? semanticIdFn(f) : JSON.stringify(f));
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push({ ...f, _hash: hash });
  }
  deduped.sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });
  return deduped;
}

// ── Ledger Path Resolution ──────────────────────────────────────────────────

/**
 * Resolve canonical ledger path.
 * - Explicit --ledger always wins
 * - Round 1 without --ledger: auto-derive from --out
 * - Round 2+ without --ledger: returns null (caller should fail fast)
 * - --no-ledger: null
 */
export function resolveLedgerPath({ explicitLedger, outFile, round, noLedger }) {
  if (noLedger) return null;
  if (explicitLedger) return path.resolve(explicitLedger);
  if (round >= 2) return null;
  if (!outFile) return null;

  const parsed = path.parse(outFile);
  const baseName = parsed.name.replace(/-result$/, '');
  const ledgerName = `${baseName}-ledger${parsed.ext}`;
  return path.resolve(parsed.dir, ledgerName);
}
