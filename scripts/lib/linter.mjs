/**
 * @fileoverview Tool pre-pass orchestration — runs linters and type-checkers,
 * normalizes output to canonical FindingSchema format.
 *
 * Design:
 * - Uses execFileSync with argv arrays (no shell, no path concat)
 * - Status envelope distinguishes no_tool / failed / timeout from ok
 * - Post-filters project-scoped tool output to audited file set
 * - Graceful: missing tools never block the audit
 *
 * SECURITY: running repo-configured linters means executing code/config the
 * repo owner controls (ESLint configs can `require()` custom rules). This is
 * equivalent to running `npm test` in the repo. Gated behind `--no-tools` CLI
 * flag or `AUDIT_LOOP_ALLOW_TOOLS=1` env. Every invocation is logged to stderr
 * for auditability.
 * @module scripts/lib/linter
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import { getProfileForFile } from './language-profiles.mjs';
import { getRuleMetadata } from './rule-metadata.mjs';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * ToolRunResult — contract for all tool executions.
 * @typedef {object} ToolRunResult
 * @property {'ok'|'no_tool'|'failed'|'timeout'} status
 * @property {RawLintFinding[]} findings
 * @property {{ files: number }} usage
 * @property {number} latencyMs
 * @property {string} stderr
 * @property {string} toolId
 * @property {string} toolKind
 */

/**
 * RawLintFinding — parser output, before normalization to FindingSchema.
 * @typedef {object} RawLintFinding
 * @property {string} file
 * @property {number} line
 * @property {number} [endLine]
 * @property {number} [column]
 * @property {string} rule
 * @property {string} message
 * @property {boolean} fixable
 */

const TOOL_TIMEOUT_MS = 60_000;
const TOOL_MAX_BUFFER_BASE = 10 * 1024 * 1024;    // 10MB
const TOOL_MAX_BUFFER_PER_FILE = 100 * 1024;      // +100KB per file

/** Scale buffer with audited file count. Prevents overflow on large repos. */
function computeMaxBuffer(fileCount) {
  return TOOL_MAX_BUFFER_BASE + fileCount * TOOL_MAX_BUFFER_PER_FILE;
}

// ── execFileSync indirection (testable) ──────────────────────────────────────
// Tests inject a fake via `setExecFileSync()` to avoid spawning real processes.
let _execFileSync = execFileSync;

/** @internal test-only */
export function setExecFileSync(fn) { _execFileSync = fn; }
/** @internal test-only */
export function resetExecFileSync() { _execFileSync = execFileSync; }

// ── Tool Availability ────────────────────────────────────────────────────────

/**
 * Check whether a tool responds to its availability probe.
 * Uses argv array (no shell, no command injection).
 * @param {[string, string[]]} probe - [command, args]
 * @returns {boolean}
 */
function isToolAvailable([command, args = []]) {
  try {
    _execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Tool Execution ───────────────────────────────────────────────────────────

/**
 * Run a single tool. Returns ToolRunResult envelope.
 * Post-filters findings to the audited file set (project-scoped tools run at repo root).
 * @param {object} toolConfig - From profile.tools[]
 * @param {string[]} auditedFiles - Files the audit is analyzing
 * @param {string} profileId - e.g. 'js', 'py'
 * @returns {ToolRunResult}
 */
export function runTool(toolConfig, auditedFiles, profileId) {
  const startMs = Date.now();
  const fileSet = new Set(auditedFiles.map(f => normalizePath(f)));
  const toolId = toolConfig.id;
  const toolKind = toolConfig.kind;

  if (!isToolAvailable(toolConfig.availabilityProbe)) {
    if (toolConfig.fallback) {
      process.stderr.write(`  [tool] ${profileId}/${toolId} not available — trying fallback ${toolConfig.fallback.id}\n`);
      return runTool(toolConfig.fallback, auditedFiles, profileId);
    }
    process.stderr.write(`  [tool] ${profileId}/${toolId} not available — skipping\n`);
    return { status: 'no_tool', findings: [], usage: { files: 0 }, latencyMs: 0, stderr: '', toolId, toolKind };
  }

  const parser = PARSERS[toolConfig.parser];
  if (!parser) {
    process.stderr.write(`  [tool] ${profileId}/${toolId}: unknown parser "${toolConfig.parser}"\n`);
    return { status: 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: `unknown parser: ${toolConfig.parser}`, toolId, toolKind };
  }

  process.stderr.write(`  [tool] ${profileId}/${toolId}: executing ${toolConfig.command} ${toolConfig.args.join(' ')}\n`);

  try {
    const stdout = _execFileSync(toolConfig.command, toolConfig.args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TOOL_TIMEOUT_MS,
      cwd: process.cwd(),
      maxBuffer: computeMaxBuffer(auditedFiles.length),
    });
    const rawFindings = parser(stdout);
    const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
    const filteredOut = rawFindings.length - filtered.length;
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${filtered.length} findings${filteredOut > 0 ? ` (${filteredOut} out-of-scope filtered)` : ''} in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: '', toolId, toolKind };
  } catch (err) {
    // Tools commonly exit non-zero when findings exist — parse stdout anyway.
    if (err.stdout) {
      try {
        const rawFindings = parser(err.stdout.toString());
        const filtered = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
        process.stderr.write(`  [tool] ${profileId}/${toolId}: ${filtered.length} findings (non-zero exit, stdout parsed) in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
        return { status: 'ok', findings: filtered, usage: { files: auditedFiles.length }, latencyMs: Date.now() - startMs, stderr: err.stderr?.toString() || '', toolId, toolKind };
      } catch { /* fall through to failure */ }
    }
    const isTimeout = err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
    process.stderr.write(`  [tool] ${profileId}/${toolId}: ${isTimeout ? 'timeout' : 'failed'}: ${(err.message || '').slice(0, 120)}\n`);
    return { status: isTimeout ? 'timeout' : 'failed', findings: [], usage: { files: 0 }, latencyMs: Date.now() - startMs, stderr: err.message || '', toolId, toolKind };
  }
}

/**
 * Run all applicable tools across the audited file set.
 * Deduplicates tools by `id` — ESLint is ONE tool for both JS and TS profiles
 * (runs once, not twice). Files from all contributing languages are unioned
 * before post-filtering.
 * @param {string[]} files
 * @returns {ToolRunResult[]}
 */
export function executeTools(files) {
  const toolsById = new Map(); // toolId → { config, profileId, files: Set }
  for (const f of files) {
    const profile = getProfileForFile(f);
    if (profile.id === 'unknown' || !profile.tools) continue;
    for (const toolConfig of profile.tools) {
      if (!toolsById.has(toolConfig.id)) {
        toolsById.set(toolConfig.id, { config: toolConfig, profileId: profile.id, files: new Set() });
      }
      toolsById.get(toolConfig.id).files.add(f);
    }
  }

  const results = [];
  for (const { config, profileId, files: toolFiles } of toolsById.values()) {
    results.push(runTool(config, [...toolFiles], profileId));
  }
  return results;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseEslintOutput(stdout) {
  if (!stdout || !stdout.trim()) return [];
  const data = JSON.parse(stdout);
  const findings = [];
  for (const file of data) {
    for (const msg of (file.messages || [])) {
      // ESLint fatal errors (parse/config failures) have `fatal: true` and no ruleId.
      // Treat them as a distinct rule so rule-metadata can map them to HIGH — otherwise
      // they fall through to the LOW CODE_SMELL _default and hide real breakage.
      let rule;
      if (msg.fatal) {
        rule = 'fatal-parse-error';
      } else {
        rule = msg.ruleId || 'unknown';
      }
      findings.push({
        file: file.filePath ? path.relative(process.cwd(), file.filePath).replace(/\\/g, '/') : '',
        line: msg.line || 1,
        endLine: msg.endLine,
        column: msg.column,
        rule,
        message: msg.message || '',
        fixable: !!msg.fix,
      });
    }
  }
  return findings;
}

export function parseRuffOutput(stdout) {
  if (!stdout || !stdout.trim()) return [];
  const data = JSON.parse(stdout);
  return data.map(item => ({
    file: item.filename ? path.relative(process.cwd(), item.filename).replace(/\\/g, '/') : '',
    line: item.location?.row || 1,
    endLine: item.end_location?.row,
    column: item.location?.column,
    rule: item.code || 'unknown',
    message: item.message || '',
    fixable: !!item.fix,
  }));
}

export function parseTscOutput(stdout) {
  // tsc --pretty false: "path/to/file.ts(10,5): error TS2304: Cannot find name 'foo'."
  const findings = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+\w+\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replace(/\\/g, '/'),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      rule: match[4],
      message: match[5].trim(),
      fixable: false,
    });
  }
  return findings;
}

export function parseFlake8PylintOutput(stdout) {
  // pylint format: "path:line: [code] message"
  const findings = [];
  const regex = /^(.+?):(\d+):\s*\[(\w+)\]\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    findings.push({
      file: match[1].replace(/\\/g, '/'),
      line: parseInt(match[2], 10),
      rule: match[3],
      message: match[4].trim(),
      fixable: false,
    });
  }
  return findings;
}

const PARSERS = {
  parseEslintOutput,
  parseTscOutput,
  parseRuffOutput,
  parseFlake8PylintOutput,
};

// ── Normalization to FindingSchema ───────────────────────────────────────────

/**
 * Normalize a single raw lint finding to FindingSchema (with classification).
 * @param {RawLintFinding} raw
 * @param {ToolRunResult} result
 * @param {number} autoIndex - 1-based sequence for ID generation
 * @returns {object} FindingSchema-shaped object
 */
export function normalizeExternalFinding(raw, result, autoIndex) {
  const meta = getRuleMetadata(result.toolId, raw.rule);
  const sourceKind = result.toolKind === 'typeChecker' ? 'TYPE_CHECKER' : 'LINTER';

  return {
    id: `T${autoIndex}`,
    severity: meta.severity,
    category: `[${meta.sonarType}] ${raw.rule}`,
    section: `${raw.file}:${raw.line}`,
    detail: (raw.message || '').slice(0, 600),
    risk: `Static analysis rule violation: ${raw.rule}`,
    recommendation: `Review and resolve rule: ${raw.rule}. ${raw.fixable ? 'Auto-fix available via tool --fix flag.' : 'Manual fix required.'}`,
    is_quick_fix: meta.isQuickFix,
    is_mechanical: true,
    principle: raw.rule,
    classification: {
      sonarType: meta.sonarType,
      effort: meta.effort,
      sourceKind,
      sourceName: result.toolId,
    },
  };
}

/**
 * Normalize all tool results into canonical findings. Skips non-OK results.
 * @param {ToolRunResult[]} results
 * @returns {object[]}
 */
export function normalizeToolResults(results) {
  const findings = [];
  let idx = 0;
  for (const result of results) {
    if (result.status !== 'ok') continue;
    for (const raw of result.findings) {
      findings.push(normalizeExternalFinding(raw, result, ++idx));
    }
  }
  return findings;
}

// ── Lint Context Injection ───────────────────────────────────────────────────

const LINT_CONTEXT_TOKEN_BUDGET = 2000; // ~8K chars

/**
 * Format normalized tool findings as a summarized block for GPT prompts.
 * Tells GPT "these are already covered — focus on architectural issues".
 * @param {object[]} normalizedFindings
 * @param {number} [budget=LINT_CONTEXT_TOKEN_BUDGET]
 * @returns {string}
 */
export function formatLintSummary(normalizedFindings, budget = LINT_CONTEXT_TOKEN_BUDGET) {
  if (normalizedFindings.length === 0) return '';

  const header = '## Pre-detected Static Analysis Findings (mechanical — already flagged)\n' +
    'The following have been detected by linters/type-checkers. Do NOT re-raise them.\n' +
    'Focus on architectural, design, and logic issues that static analysis cannot detect.\n\n';

  const charBudget = budget * 4;

  // Small set: list directly
  if (normalizedFindings.length <= 15) {
    const lines = normalizedFindings.map(f =>
      `- ${f.section}: [${f.principle}] ${(f.detail || '').slice(0, 80)}`
    );
    const block = header + lines.join('\n');
    if (block.length <= charBudget) return block;
  }

  // Large set: summarize by rule
  const ruleCount = {};
  const sevCount = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of normalizedFindings) {
    ruleCount[f.principle] = (ruleCount[f.principle] || 0) + 1;
    sevCount[f.severity]++;
  }
  const topRules = Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => `  - ${rule}: ${count}x`)
    .join('\n');
  return header +
    `**Summary**: ${normalizedFindings.length} findings (H:${sevCount.HIGH} M:${sevCount.MEDIUM} L:${sevCount.LOW})\n` +
    `**Top rules**:\n${topRules}\n\n` +
    `Do NOT re-raise these patterns.`;
}
