/**
 * Code analysis and chunking utilities for map-reduce audit architecture.
 * Extracted from shared.mjs — handles file chunking, dependency graphs, and audit units.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import { getProfileForFile, getProfile } from './language-profiles.mjs';

/**
 * Default profile for legacy callers that don't supply a profile argument.
 *
 * BACKWARD-COMPAT CONTRACT (Phase A): Before Phase A, these functions used
 * hardcoded JS regex patterns. Callers that omit `profile` now get identical
 * behavior via the JS profile, preserving the pre-Phase-A contract.
 *
 * For non-JS files, prefer to either:
 *   - Pass `profile` explicitly, OR
 *   - Call via `chunkLargeFile(src, filePath)` which auto-detects from filePath
 *
 * Known consequence: bare calls like `splitAtFunctionBoundaries(pySource)` with
 * no profile arg will use JS regex on Python source. This is the documented
 * fallback — callers are responsible for providing profile/filePath context
 * when analyzing non-JS code. See phase-a-language-aware-analysis.md §5.
 */
const DEFAULT_PROFILE = getProfile('js');

// ── Token Estimation ─────────────────────────────────────────────────────────

/** Estimate token count from character length (~4 chars per token). */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ── Source Splitting ─────────────────────────────────────────────────────────

/**
 * Extract everything before the first function/class/const export.
 * Uses profile's getBoundaries capability. Returns first 2000 chars
 * for UNKNOWN profile or when no boundary found (safe degraded behavior).
 * @param {string} source - Source code
 * @param {object} [profile] - Language profile (falls back to JS for backward compat)
 * @returns {string} Import/header block
 */
export function extractImportBlock(source, profile = DEFAULT_PROFILE) {
  const effectiveProfile = profile || DEFAULT_PROFILE;
  if (!effectiveProfile.getBoundaries) {
    return source.slice(0, Math.min(source.length, 2000));
  }
  const lines = source.split('\n');
  const boundaries = effectiveProfile.getBoundaries(lines);
  if (boundaries.length === 0) {
    return source.slice(0, Math.min(source.length, 2000));
  }
  return lines.slice(0, boundaries[0]).join('\n');
}

/**
 * Split source at function/class boundaries using profile's getBoundaries.
 * Returns [{source, startLine}] chunks. No branching on profile.id.
 * @param {string} source - Source code
 * @param {object} [profile] - Language profile (falls back to JS for backward compat)
 * @returns {Array<{source: string, startLine: number}>}
 */
export function splitAtFunctionBoundaries(source, profile = DEFAULT_PROFILE) {
  const effectiveProfile = profile || DEFAULT_PROFILE;
  const lines = source.split('\n');
  const boundaries = effectiveProfile.getBoundaries
    ? effectiveProfile.getBoundaries(lines)
    : [];

  if (boundaries.length === 0) {
    return [{ source, startLine: 1 }]; // Whole file as one chunk
  }

  const chunks = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    chunks.push({ source: lines.slice(start, end).join('\n'), startLine: start + 1 });
  }
  return chunks;
}

// ── File Chunking ────────────────────────────────────────────────────────────

/**
 * Chunk a large file by function boundaries, with import block prepended to each chunk.
 * Falls back to line-count splitting if no function boundaries found.
 * Profile is auto-detected from filePath when not provided.
 * @param {string} source - Source code
 * @param {string} filePath - File path (for profile detection + logging)
 * @param {number} [maxChunkTokens=6000] - Maximum tokens per chunk
 * @param {object} [profile] - Language profile (auto-detected from filePath if omitted)
 * @returns {Array<{imports: string, items: Array<{source: string, startLine: number}>, tokens: number}>}
 */
export function chunkLargeFile(source, filePath, maxChunkTokens = 6000, profile = null) {
  const resolvedProfile = profile || getProfileForFile(filePath);
  const imports = extractImportBlock(source, resolvedProfile);
  const functions = splitAtFunctionBoundaries(source, resolvedProfile);

  if (functions.length <= 1) {
    // No function boundaries found — line-count fallback
    const lines = source.split('\n');
    const linesPerChunk = Math.floor(maxChunkTokens * 4 / 80); // ~80 chars per line avg
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerChunk) {
      chunks.push({
        imports,
        items: [{ source: lines.slice(i, i + linesPerChunk).join('\n'), startLine: i + 1 }],
        tokens: estimateTokens(imports) + estimateTokens(lines.slice(i, i + linesPerChunk).join('\n'))
      });
    }
    return chunks;
  }

  const chunks = [];
  let current = { imports, items: [], tokens: estimateTokens(imports) };

  for (const fn of functions) {
    const fnTokens = estimateTokens(fn.source);
    if (current.tokens + fnTokens > maxChunkTokens && current.items.length > 0) {
      chunks.push(current);
      current = { imports, items: [], tokens: estimateTokens(imports) };
    }
    current.items.push(fn);
    current.tokens += fnTokens;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}

// ── Export Extraction ────────────────────────────────────────────────────────

/**
 * Extract just the export signatures from a file (for peripheral files in oversized clusters).
 * Profile-dispatched export regex (Python uses def/class/ALL_CAPS; JS/TS uses `export`).
 * @param {string} filePath - File path to extract exports from
 * @returns {string} Export signatures as a comment block
 */
export function extractExportsOnly(filePath) {
  const profile = getProfileForFile(filePath);
  if (!profile.exportRegex) return `// ${filePath} — unsupported language`;
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return '';
  const source = fs.readFileSync(absPath, 'utf-8');
  const lines = source.split('\n');
  const exports = lines.filter(l => profile.exportRegex.test(l));
  return `// ${filePath} — exports only\n${exports.join('\n')}`;
}

// ── Dependency Graph ─────────────────────────────────────────────────────────

/**
 * Build an import graph from file list, dispatching to each file's language profile.
 * @param {string[]} files - File paths to analyze
 * @param {object} [langContext] - Repo context for resolvers (Python package roots, etc.)
 * @returns {Map<string, Set<string>>} file -> Set of files it imports
 */
export function buildDependencyGraph(files, langContext = null) {
  const graph = new Map();
  const repoFileSet = langContext?.repoFileSet || new Set(files.map(normalizePath));

  for (const file of files) {
    const normFile = normalizePath(file);
    graph.set(normFile, new Set());
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const profile = getProfileForFile(file);
    if (!profile.importRegex || !profile.resolveImport) continue; // UNKNOWN / unsupported

    const content = fs.readFileSync(absPath, 'utf-8');
    // Clone the regex so .lastIndex state doesn't leak across files
    const regex = new RegExp(profile.importRegex.source, profile.importRegex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const importRecord = profile.importExtractor(match);
      if (!importRecord) continue;
      const resolvedPaths = profile.resolveImport(importRecord, file, repoFileSet, langContext);
      for (const resolved of resolvedPaths) {
        graph.get(normFile).add(normalizePath(resolved));
      }
    }
  }
  return graph;
}

// ── Audit Units ──────────────────────────────────────────────────────────────

/**
 * Group files into audit units that fit within a context window.
 * Uses greedy bin-packing sorted by descending token count.
 * Files exceeding the budget are chunked by function boundaries.
 * @param {string[]} files - File paths to group
 * @param {number} [maxTokensPerUnit=30000] - Maximum tokens per audit unit
 * @returns {Array<{files: string[], tokens: number, chunk?: object, strategy?: string}>}
 */
export function buildAuditUnits(files, maxTokensPerUnit = 30000) {
  // Score and sort files
  const scored = files.map(f => {
    const absPath = path.resolve(f);
    const size = fs.existsSync(absPath) ? fs.statSync(absPath).size : 0;
    return { path: f, tokens: Math.ceil(size / 4), size };
  }).sort((a, b) => b.tokens - a.tokens);

  // Simple greedy bin-packing into units
  const units = [];
  let current = { files: [], tokens: 0 };

  for (const file of scored) {
    if (current.tokens + file.tokens > maxTokensPerUnit && current.files.length > 0) {
      units.push(current);
      current = { files: [], tokens: 0 };
    }

    // If single file exceeds budget, it needs chunking
    if (file.tokens > maxTokensPerUnit) {
      const absPath = path.resolve(file.path);
      if (fs.existsSync(absPath)) {
        const source = fs.readFileSync(absPath, 'utf-8');
        const chunks = chunkLargeFile(source, file.path, Math.floor(maxTokensPerUnit * 0.8));
        for (const chunk of chunks) {
          units.push({ files: [file.path], tokens: chunk.tokens, chunk, strategy: 'chunked' });
        }
      }
      continue;
    }

    current.files.push(file.path);
    current.tokens += file.tokens;
  }
  if (current.files.length > 0) units.push(current);

  process.stderr.write(`  [map-reduce] ${files.length} files → ${units.length} audit units\n`);
  return units;
}

// ── Reduce Prompt ────────────────────────────────────────────────────────────

/** System prompt for the REDUCE phase of map-reduce auditing. */
export const REDUCE_SYSTEM_PROMPT = `You are a SENIOR CODE REVIEWER synthesizing findings from multiple parallel audit passes.

Multiple reviewers have independently audited different parts of the same codebase. Your job:

1. DEDUPLICATE: Remove findings that describe the same issue (different wording, same problem)
2. ELEVATE PATTERNS: If 3+ reviewers found the same class of issue in different files, create ONE systemic finding at elevated severity
3. CROSS-FILE ISSUES: Identify issues that span multiple files (e.g., inconsistent error handling, missing auth in related routes)
4. RANK: Order findings by severity (HIGH first), then by systemic impact

Do NOT:
- Add new findings that no reviewer mentioned
- Change the substance of findings (only merge/elevate)
- Lower severity unless merging duplicates

Mark systemic findings with category prefix [SYSTEMIC].

PRESERVE the \`classification\` object on every finding (sonarType, effort, sourceKind, sourceName).
When merging duplicates, keep the highest severity source's classification and set effort to the MAX
of the merged findings (MAJOR > MEDIUM > EASY > TRIVIAL). Never drop or null the classification field.`;

// ── Context Measurement ──────────────────────────────────────────────────────

/**
 * Measure total character count of files that would be sent in a context block.
 * @param {string[]} filePaths
 * @param {number} maxPerFile
 * @returns {number}
 */
export function measureContextChars(filePaths, maxPerFile = 10000) {
  let total = 0;
  for (const p of filePaths) {
    const abs = path.resolve(p);
    if (fs.existsSync(abs)) {
      const size = fs.statSync(abs).size;
      total += Math.min(size, maxPerFile);
    }
  }
  return total;
}
