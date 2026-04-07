/**
 * @fileoverview Phase D.7 — audit-summary parser.
 *
 * Extracts deferred debt entries from `docs/complete/*-audit-summary.md`
 * files (and docs/plans/*-audit-summary.md). Produces StagingRecord[] with
 * explicit per-field `parseConfidence` markers. Staged records NEVER auto-
 * promote to the live ledger — a human reviews + promotes via --promote.
 *
 * Two parseable formats observed:
 *   1. Bullet list:    `- <description> — <findingId>`
 *   2. Markdown table: `| <findingId> | <description> | <note> |`
 *
 * Both are supported. Files using neither format produce an empty result
 * with a diagnostic, not an error.
 *
 * @module scripts/lib/backfill-parser
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * StagingRecord — pre-promotion shape. Fields carry confidence markers so
 * the operator can see what the parser was certain about vs guessing.
 *
 * confidence: 'high' | 'medium' | 'low'
 *   high   — extracted verbatim (description, findingId)
 *   medium — inferred from heuristics (severity from findingId prefix)
 *   low    — placeholder needing human fill (topicId, affectedFiles, classification)
 *
 * @typedef {object} StagingRecord
 * @property {string} sourceFile - path to summary file this came from
 * @property {string} findingId  - original audit ID (H1, M3, L2)
 * @property {string} description
 * @property {string} [note]
 * @property {string} severity   - HIGH|MEDIUM|LOW inferred from findingId prefix
 * @property {string} suggestedTopicId - placeholder hash, low confidence
 * @property {string[]} inferredFiles - files mentioned in description backticks
 * @property {Record<string,string>} parseConfidence
 */

// ── Format detection ────────────────────────────────────────────────────────

const BULLET_LINE = /^-\s+(.+?)\s+—\s+([HMLT])(\d+)\s*$/;
// Table row must have at least 3 columns: | findingId | description | note |
const TABLE_ROW = /^\|\s*([HMLT])(\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|/;

function severityFromPrefix(prefix) {
  switch (prefix) {
    case 'H': return 'HIGH';
    case 'M': return 'MEDIUM';
    case 'L': return 'LOW';
    case 'T': return 'LOW';  // tool findings default to LOW
    default: return 'LOW';
  }
}

// ── File-path extraction ────────────────────────────────────────────────────

// Backtick-wrapped file paths with known code extensions.
// Conservative — only matches obvious source paths.
const FILE_PATH_IN_BACKTICKS = /`([^`]*\.(?:mjs|js|ts|py|sql|yml|yaml|json|md))`/g;

function extractFilesFromText(text) {
  if (!text) return [];
  const files = new Set();
  let m;
  FILE_PATH_IN_BACKTICKS.lastIndex = 0;
  while ((m = FILE_PATH_IN_BACKTICKS.exec(text)) !== null) {
    // Skip inline identifiers like `foo.js` if they have no slash — too noisy
    const candidate = m[1];
    if (candidate.includes('/') || candidate.includes('.audit/')) {
      files.add(candidate);
    }
  }
  return [...files];
}

// ── Phase extraction ────────────────────────────────────────────────────────

/**
 * Extract a phase identifier from the filename, e.g. "phase-b" from
 * "phase-b-sonarqube-classification-audit-summary.md".
 */
export function extractPhaseTag(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^(phase-[a-z])/i);
  if (m) return m[1].toLowerCase();
  // Non-phase summaries like "learning-system-v2-audit-summary.md"
  return base.replace(/-audit-summary\.md$/, '').toLowerCase();
}

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse a single audit-summary file into staging records.
 *
 * Only scans lines under headings that match /deferred|pre-existing|out of scope/i
 * to avoid picking up confirmed-fixed findings or narrative prose.
 *
 * @param {string} filePath
 * @returns {{ records: StagingRecord[], diagnostics: string[] }}
 */
export function parseSummaryFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { records: [], diagnostics: [`file not found: ${filePath}`] };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSummaryContent(content, { sourceFile: filePath });
}

/**
 * Parse summary content (string) — testable without filesystem.
 * @param {string} content
 * @param {object} [opts]
 * @param {string} [opts.sourceFile] - For record attribution
 * @returns {{ records: StagingRecord[], diagnostics: string[] }}
 */
export function parseSummaryContent(content, { sourceFile = 'inline' } = {}) {
  const diagnostics = [];
  const records = [];
  const lines = content.split(/\r?\n/);

  const phaseTag = extractPhaseTag(sourceFile);
  let inDeferredSection = false;
  let sawAnyHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Heading detection
    const headingMatch = line.match(/^##+\s+(.+?)\s*$/);
    if (headingMatch) {
      sawAnyHeading = true;
      const heading = headingMatch[1].toLowerCase();
      inDeferredSection = /deferred|pre-existing|out of scope|known limitations/.test(heading);
      continue;
    }

    if (!inDeferredSection) continue;

    // Try bullet format first
    const bulletMatch = line.match(BULLET_LINE);
    if (bulletMatch) {
      const [, description, prefix, num] = bulletMatch;
      records.push(buildRecord({
        sourceFile, phaseTag, findingId: prefix + num,
        description: description.trim(), severity: severityFromPrefix(prefix),
      }));
      continue;
    }

    // Try table format
    const tableMatch = line.match(TABLE_ROW);
    if (tableMatch) {
      const [, prefix, num, description, note] = tableMatch;
      // Skip header separator rows like | --- | --- |
      if (description.match(/^-+$/)) continue;
      records.push(buildRecord({
        sourceFile, phaseTag, findingId: prefix + num,
        description: description.trim(), note: note.trim(),
        severity: severityFromPrefix(prefix),
      }));
      continue;
    }
  }

  if (!sawAnyHeading) {
    diagnostics.push('no markdown headings found — is this really an audit-summary?');
  } else if (records.length === 0) {
    diagnostics.push('no deferred-section entries extracted');
  }

  return { records, diagnostics };
}

function buildRecord({ sourceFile, phaseTag, findingId, description, note = '', severity }) {
  const inferredFiles = extractFilesFromText(description + ' ' + (note || ''));
  // Placeholder topicId: hash of (phase, findingId, description) — gives stable
  // identity per summary but operator should replace with real topicId on promote
  // if a corresponding live topicId exists.
  const suggestedTopicId = crypto.createHash('sha256')
    .update(`${phaseTag}|${findingId}|${description}`)
    .digest('hex').slice(0, 12);

  return {
    sourceFile: path.relative(process.cwd(), path.resolve(sourceFile)).replace(/\\/g, '/'),
    phaseTag,
    findingId,
    description,
    note: note || undefined,
    severity,
    suggestedTopicId,
    inferredFiles,
    parseConfidence: {
      description: 'high',        // extracted verbatim
      findingId: 'high',          // extracted verbatim
      severity: 'medium',         // inferred from prefix
      suggestedTopicId: 'low',    // placeholder hash
      inferredFiles: inferredFiles.length > 0 ? 'medium' : 'low',
    },
  };
}

/**
 * Parse multiple summary files, union their records.
 * @param {string[]} filePaths
 * @returns {{ records: StagingRecord[], perFile: Record<string, {count:number, diagnostics:string[]}> }}
 */
export function parseSummaryFiles(filePaths) {
  const perFile = {};
  const all = [];
  for (const fp of filePaths) {
    const { records, diagnostics } = parseSummaryFile(fp);
    perFile[fp] = { count: records.length, diagnostics };
    all.push(...records);
  }
  return { records: all, perFile };
}
