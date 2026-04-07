/**
 * @fileoverview Phase D — debt-capture helpers.
 *
 * Transforms a finding (as produced by GPT/Gemini + enriched with metadata)
 * into a PersistedDebtEntry ready for writeDebtEntries().
 *
 * Handles:
 *  - Sensitivity detection (file path + content scan, fix H6 + R2-H5)
 *  - Secret redaction of free-text fields BEFORE persistence
 *  - Copying classification envelope from the finding
 *  - Computing the deferredRun stamp
 *
 * Pairs with the orchestrator (SKILL.md Step 3.6): the orchestrator decides
 * WHAT to defer and WHY; this module handles the mechanical transform.
 *
 * @module scripts/lib/debt-capture
 */

import path from 'node:path';
import { isSensitiveFile } from './file-io.mjs';
import { scanForSecrets, redactFields, redactSecrets } from './secret-patterns.mjs';
import { resolveOwner } from './owner-resolver.mjs';

/**
 * Check whether a finding should be marked sensitive.
 *   Path check: any affectedFile matches isSensitiveFile()
 *   Content check: free-text fields contain secret patterns
 *
 * @param {object} finding - enriched finding with affectedFiles, section, detail, category
 * @returns {{ sensitive: boolean, reasons: string[] }}
 */
export function computeSensitivity(finding) {
  const reasons = [];

  // Path-based check
  const files = finding.affectedFiles || (finding._primaryFile ? [finding._primaryFile] : []);
  const sensitiveFiles = files.filter(f => isSensitiveFile(path.basename(f)));
  if (sensitiveFiles.length > 0) {
    reasons.push(`path:${sensitiveFiles.join(',')}`);
  }

  // Content-based check across all free-text fields
  const fieldsToScan = ['detail', 'section', 'category', 'risk', 'recommendation'];
  for (const field of fieldsToScan) {
    const value = finding[field];
    if (typeof value !== 'string') continue;
    const { matched, patterns } = scanForSecrets(value);
    if (matched) {
      reasons.push(`content:${field}:${patterns.join(',')}`);
    }
  }

  return { sensitive: reasons.length > 0, reasons };
}

/**
 * Default max length for the persisted detailSnapshot.
 * Balances context retention with persistence footprint.
 */
const DETAIL_SNAPSHOT_MAX = 600;

/**
 * Transform a finding into a PersistedDebtEntry payload.
 *
 * The caller MUST supply deferredReason + deferredRationale (operator decisions).
 * Per-reason conditional fields (blockedBy, followupPr, etc.) are passed through.
 *
 * Secret patterns are redacted from free-text fields BEFORE persistence.
 * If any redactions occurred, `sensitive: true` is set automatically.
 *
 * @param {object} finding - enriched finding (with _hash, _primaryFile, _pass, affectedFiles, classification)
 * @param {object} captureArgs
 * @param {string} captureArgs.deferredReason - one of DeferredReasonEnum
 * @param {string} captureArgs.deferredRationale - >= 20 chars, operator-authored
 * @param {string} captureArgs.deferredRun - runId stamp (SID)
 * @param {string} [captureArgs.blockedBy]
 * @param {string} [captureArgs.followupPr]
 * @param {string} [captureArgs.approver]
 * @param {string} [captureArgs.approvedAt]
 * @param {string} [captureArgs.policyRef]
 * @param {string} [captureArgs.owner]
 * @returns {{ entry: object, sensitivity: {sensitive, reasons}, redactions: {field, patterns}[] }}
 */
export function buildDebtEntry(finding, captureArgs) {
  // Required orchestrator-provided fields
  const {
    deferredReason,
    deferredRationale,
    deferredRun,
    blockedBy,
    followupPr,
    approver,
    approvedAt,
    policyRef,
    owner,
  } = captureArgs;

  // 1. Sensitivity scan BEFORE any transforms
  const sensitivity = computeSensitivity(finding);

  // 2. Redact secret patterns from the fields we're about to persist
  const toRedact = {
    detail: finding.detail,
    section: finding.section,
    category: finding.category,
  };
  const { obj: cleaned, redacted } = redactFields(toRedact, ['detail', 'section', 'category']);

  // Also redact the operator-authored rationale (operators may paste snippets)
  const ratResult = redactSecrets(deferredRationale || '');
  const cleanRationale = ratResult.text;
  if (ratResult.redacted.length > 0) {
    redacted.push({ field: 'deferredRationale', patterns: ratResult.redacted });
  }

  // Any redaction implies sensitive: true even if path check didn't flag
  const sensitive = sensitivity.sensitive || redacted.length > 0;

  // 3. Assemble PersistedDebtEntry shape
  const entry = {
    source: 'debt',
    topicId: finding._topicId || finding._hash || finding.topicId,
    semanticHash: finding._hash || finding.semanticHash || '',
    severity: finding.severity,
    category: cleaned.category || '',
    section: cleaned.section || '',
    detailSnapshot: (cleaned.detail || '').slice(0, DETAIL_SNAPSHOT_MAX),
    affectedFiles: finding.affectedFiles || (finding._primaryFile ? [finding._primaryFile] : []),
    affectedPrinciples: finding.affectedPrinciples || (finding.principle ? [finding.principle] : []),
    pass: finding._pass || 'unknown',
    classification: finding.classification || null,
    deferredReason,
    deferredAt: new Date().toISOString(),
    deferredRun,
    deferredRationale: cleanRationale,
    contentAliases: [],
    sensitive,
  };

  // Per-reason conditional fields — pass through only when set
  if (blockedBy !== undefined) entry.blockedBy = blockedBy;
  if (followupPr !== undefined) entry.followupPr = followupPr;
  if (approver !== undefined) entry.approver = approver;
  if (approvedAt !== undefined) entry.approvedAt = approvedAt;
  if (policyRef !== undefined) entry.policyRef = policyRef;

  // Owner resolution (D.5): explicit arg wins, else consult CODEOWNERS for
  // the first affected file. If neither resolves → undefined (unassigned).
  const primaryFile = entry.affectedFiles[0];
  const resolvedOwner = resolveOwner(primaryFile, { explicitOwner: owner });
  if (resolvedOwner) entry.owner = resolvedOwner;

  return {
    entry,
    sensitivity: { sensitive, reasons: sensitivity.reasons },
    redactions: redacted,
  };
}

/**
 * Suggest whether a finding is a deferral candidate (advisory only — operator
 * makes final call in SKILL.md Step 3). Matches the triage model:
 *   validity=valid + scope=out-of-scope → high confidence candidate
 *   validity=valid + scope=in-scope + HIGH → NOT a candidate (must fix)
 *
 * @param {object} finding - enriched finding
 * @param {object} opts
 * @param {string[]} [opts.changedFiles] - files in audit scope
 * @returns {{ isCandidate: boolean, reason: string }}
 */
export function suggestDeferralCandidate(finding, { changedFiles = [] } = {}) {
  // If finding is in-scope and HIGH → must-fix, not candidate
  const files = finding.affectedFiles || (finding._primaryFile ? [finding._primaryFile] : []);
  const inScope = files.some(f => changedFiles.some(cf => f.includes(cf) || cf.includes(f)));

  if (inScope && finding.severity === 'HIGH') {
    return { isCandidate: false, reason: 'in-scope HIGH finding — must fix this round' };
  }
  if (inScope) {
    return { isCandidate: false, reason: 'in-scope — defer only via accepted-permanent/deferred-followup' };
  }
  return { isCandidate: true, reason: 'out-of-scope — eligible for deferral' };
}
