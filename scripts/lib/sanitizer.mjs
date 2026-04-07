/**
 * @fileoverview Outcome sanitization pipeline — sanitize outcome data before
 * sending to external LLMs for refinement or prompt evolution.
 * Prevents leaking secrets, internal paths, or sensitive code excerpts.
 * @module scripts/lib/sanitizer
 */

import { z } from 'zod';
import { isSensitiveFile } from './file-io.mjs';

// ── Sanitized Output Schema ─────────────────────────────────────────────────

export const SanitizedOutcomeSchema = z.object({
  category: z.string().optional(),
  severity: z.string().optional(),
  primaryFile: z.string(),
  detail: z.string(),
  ruling: z.string().optional(),
  rulingRationale: z.string(),
  accepted: z.boolean(),
  pass: z.string().optional(),
  _recencyBucket: z.enum(['recent', 'mid', 'old'])
});

// ── Recency Bucketing ───────────────────────────────────────────────────────

/**
 * Classify outcome recency for sampling after sanitization.
 * Enables recency-weighted sampling without exposing raw timestamps.
 */
export function recencyBucket(ts) {
  if (!ts) return 'old';
  const ageMs = Date.now() - ts;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return 'recent';    // < 7 days
  if (ageMs < 30 * 24 * 60 * 60 * 1000) return 'mid';       // < 30 days
  return 'old';
}

// ── Path Sanitization ───────────────────────────────────────────────────────

/** Sanitize file path: two-level (directory/basename), redact absolute paths. */
export function sanitizePath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || 'unknown';
}

// ── Secret Redaction ────────────────────────────────────────────────────────

// Known safe patterns for long tokens (20+ chars) that should not be redacted
const SAFE_LONG_TOKEN_PATTERNS = [
  /^rev-[a-f0-9]+$/,               // Prompt revision IDs (rev-abc123456789)
  /^audit-\d+$/,                    // Session IDs (audit-1234567890)
  /^[a-f0-9]{20,40}$/,             // Git commit hashes, SHA hashes (hex-only)
];

/** Detect and redact common secret patterns in text. */
export function redactSecrets(text) {
  return text
    .replace(/(key|token|secret|password|api_key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/[A-Za-z0-9_-]{20,}/g, (match) => {
      // Preserve known safe internal identifiers (20+ chars that are project artifacts)
      if (SAFE_LONG_TOKEN_PATTERNS.some(p => p.test(match))) return match;
      return '[REDACTED_TOKEN]';
    });
}

// ── Primary File Backfill ───────────────────────────────────────────────────

/**
 * Migration adapter for outcomes missing primaryFile.
 * Reconstructs from evaluation records where possible, tags as 'unresolvable' if not.
 */
export function backfillPrimaryFile(outcomes, evaluationRecords) {
  for (const o of outcomes) {
    if (o.primaryFile) continue;
    const evalMatch = evaluationRecords.find(
      e => e.runId === o.runId && e.findingEditLinks?.some(l => l.semanticHash === o.semanticHash)
    );
    const link = evalMatch?.findingEditLinks?.find(l => l.semanticHash === o.semanticHash);
    o.primaryFile = link?.edits?.[0]?.file || 'unresolvable';
  }
  return outcomes;
}

// ── Main Sanitization ───────────────────────────────────────────────────────

/**
 * Sanitize outcome records before external LLM calls.
 * Applied in refine-prompts.mjs and evolve-prompts.mjs before any sampling.
 * @param {object[]} outcomes
 * @returns {object[]} Sanitized outcomes (Zod-validated, only whitelisted fields)
 */
export function sanitizeOutcomes(outcomes) {
  let filteredCount = 0;
  let schemaRejectedCount = 0;
  const result = outcomes
    .filter(o => {
      // Require normalized file metadata — NOT section (unreliable logical label)
      const file = o.primaryFile || o.affectedFiles?.[0];
      if (!file) { filteredCount++; return false; }
      // Check ALL referenced files for sensitivity, not just the primary
      const allFiles = [o.primaryFile, ...(o.affectedFiles || [])].filter(Boolean);
      if (allFiles.some(f => isSensitiveFile(f))) { filteredCount++; return false; }
      return true;
    })
    .map(o => {
      // Resolve primary file once, reuse for both filter and mapping
      const resolvedFile = o.primaryFile || o.affectedFiles?.[0] || 'unknown';
      const raw = {
        category: o.category,
        severity: o.severity,
        primaryFile: sanitizePath(resolvedFile),
        detail: redactSecrets(o.detail?.slice(0, 300) || ''),
        ruling: o.ruling,
        rulingRationale: redactSecrets(o.rulingRationale?.slice(0, 200) || ''),
        accepted: !!o.accepted,
        pass: o.pass,
        _recencyBucket: recencyBucket(o.timestamp || o._importedAt)
      };
      // Validate — skip records that don't pass schema
      const parseResult = SanitizedOutcomeSchema.safeParse(raw);
      if (!parseResult.success) { schemaRejectedCount++; return null; }
      return parseResult.data;
    })
    .filter(Boolean);

  const totalDropped = filteredCount + schemaRejectedCount;
  if (totalDropped > 0) {
    process.stderr.write(`  [sanitizer] Dropped ${totalDropped} records (${filteredCount} filtered, ${schemaRejectedCount} schema-rejected) from ${outcomes.length} total\n`);
  }
  return result;
}
