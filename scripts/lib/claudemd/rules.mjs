/**
 * @fileoverview Rule definitions for CLAUDE.md hygiene linter.
 * 9 deterministic rules. No deferred v2 rules.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  resolveReferencedPath, extractFileRefs, extractFunctionRefs,
  extractEnvVarRefs, buildFunctionIndex, buildEnvVarIndex,
  DEFAULT_IGNORE_FUNCTIONS
} from './ref-checker.mjs';
import { findSimilarParagraphs } from './doc-similarity.mjs';

/**
 * Generate a stable semantic ID for a hygiene finding.
 */
function semanticId(ruleId, filePath, normalizedContent) {
  const hash = crypto.createHash('sha256')
    .update(`hygiene:${ruleId}:${filePath}:${normalizedContent}`)
    .digest('hex');
  return hash.slice(0, 16);
}

/** Default rule configuration. */
export const DEFAULT_RULES = {
  'size/claude-md': { severity: 'warn', maxBytes: 3072 },
  'size/agents-md': { severity: 'warn', maxBytes: 4096 },
  'size/skill-md': { severity: 'warn', maxBytes: 30720 },
  'stale/file-ref': { severity: 'error' },
  'stale/function-ref': { severity: 'warn', ignore: [] },
  'stale/env-var': { severity: 'warn' },
  'dup/cross-file': { severity: 'warn', similarityThreshold: 0.8 },
  'ref/deep-code-detail': { severity: 'warn', maxCodeBlocks: 5 },
  'sync/claude-agents': { severity: 'warn' },
};

/**
 * Run all enabled rules against scanned instruction files.
 * @param {Array<{ path: string, absPath: string, content: string, sizeBytes: number }>} files
 * @param {string} repoRoot
 * @param {object} config - Rule configuration
 * @returns {Array<{ ruleId: string, severity: string, file: string, line: number|null, message: string, semanticId: string, fixable: boolean }>}
 */
export function runRules(files, repoRoot, config = {}) {
  // Deep merge: per-rule config overrides individual fields, not whole objects
  const rules = {};
  for (const [key, defaults] of Object.entries(DEFAULT_RULES)) {
    rules[key] = { ...defaults, ...(config[key] || {}) };
  }
  const findings = [];

  // Build indexes once for all reference checks
  let functionIndex = null;
  let envVarIndex = null;

  if (rules['stale/function-ref']?.severity !== 'off') {
    functionIndex = buildFunctionIndex(repoRoot);
  }
  if (rules['stale/env-var']?.severity !== 'off') {
    envVarIndex = buildEnvVarIndex(repoRoot);
  }

  for (const file of files) {
    const basename = path.basename(file.path).toUpperCase();

    // Size rules
    if (basename === 'CLAUDE.MD') {
      checkSize(file, rules['size/claude-md'], 'size/claude-md', findings);
    } else if (basename === 'AGENTS.MD') {
      checkSize(file, rules['size/agents-md'], 'size/agents-md', findings);
    } else if (basename === 'SKILL.MD') {
      checkSize(file, rules['size/skill-md'], 'size/skill-md', findings);
    }

    // Stale file references
    if (rules['stale/file-ref']?.severity !== 'off') {
      checkStaleFileRefs(file, repoRoot, rules['stale/file-ref'], findings);
    }

    // Stale function references
    if (functionIndex && rules['stale/function-ref']?.severity !== 'off') {
      checkStaleFunctionRefs(file, functionIndex, rules['stale/function-ref'], findings);
    }

    // Stale env var references
    if (envVarIndex && rules['stale/env-var']?.severity !== 'off') {
      checkStaleEnvVarRefs(file, envVarIndex, rules['stale/env-var'], findings);
    }

    // Deep code detail
    if (rules['ref/deep-code-detail']?.severity !== 'off') {
      checkDeepCodeDetail(file, rules['ref/deep-code-detail'], findings);
    }
  }

  // Cross-file rules
  if (rules['dup/cross-file']?.severity !== 'off') {
    checkCrossFileDuplication(files, rules['dup/cross-file'], findings);
  }

  if (rules['sync/claude-agents']?.severity !== 'off') {
    checkClaudeAgentsSync(files, rules['sync/claude-agents'], findings);
  }

  return findings;
}

function checkSize(file, ruleConfig, ruleId, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const maxBytes = ruleConfig.maxBytes ?? 3072;
  if (file.sizeBytes > maxBytes) {
    findings.push({
      ruleId,
      severity: ruleConfig.severity,
      file: file.path,
      line: null,
      message: `File is ${file.sizeBytes} bytes (limit: ${maxBytes}). Consider extracting content to supporting docs.`,
      semanticId: semanticId(ruleId, file.path, file.path),
      fixable: false,
    });
  }
}

function checkStaleFileRefs(file, repoRoot, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const refs = extractFileRefs(file.content);
  for (const { ref, line } of refs) {
    const result = resolveReferencedPath(file.path, ref, repoRoot);
    if (result.skip) continue;
    if (!result.exists) {
      findings.push({
        ruleId: 'stale/file-ref',
        severity: ruleConfig.severity,
        file: file.path,
        line,
        message: `Referenced path '${ref}' does not exist (resolved: ${result.resolved})`,
        semanticId: semanticId('stale/file-ref', file.path, result.resolved),
        fixable: true,
      });
    }
  }
}

function checkStaleFunctionRefs(file, functionIndex, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const ignoreSet = new Set([
    ...DEFAULT_IGNORE_FUNCTIONS,
    ...(ruleConfig.ignore || []),
  ]);

  const refs = extractFunctionRefs(file.content);
  for (const { name, line } of refs) {
    if (ignoreSet.has(name)) continue;
    if (!functionIndex.has(name)) {
      findings.push({
        ruleId: 'stale/function-ref',
        severity: ruleConfig.severity,
        file: file.path,
        line,
        message: `Referenced function/class '${name}' not found in source files`,
        semanticId: semanticId('stale/function-ref', file.path, name),
        fixable: false,
      });
    }
  }
}

function checkStaleEnvVarRefs(file, envVarIndex, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const refs = extractEnvVarRefs(file.content);
  for (const { name, line } of refs) {
    if (!envVarIndex.has(name)) {
      findings.push({
        ruleId: 'stale/env-var',
        severity: ruleConfig.severity,
        file: file.path,
        line,
        message: `Env var '${name}' not found in .env.example or source code`,
        semanticId: semanticId('stale/env-var', file.path, name),
        fixable: false,
      });
    }
  }
}

function checkDeepCodeDetail(file, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const maxBlocks = ruleConfig.maxCodeBlocks ?? 5;
  const codeBlocks = (file.content.match(/^```/gm) || []).length / 2;
  if (codeBlocks > maxBlocks) {
    findings.push({
      ruleId: 'ref/deep-code-detail',
      severity: ruleConfig.severity,
      file: file.path,
      line: null,
      message: `File contains ~${Math.floor(codeBlocks)} fenced code blocks (limit: ${maxBlocks}). Consider moving code examples to supporting docs.`,
      semanticId: semanticId('ref/deep-code-detail', file.path, file.path),
      fixable: false,
    });
  }
}

function checkCrossFileDuplication(files, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;
  const threshold = ruleConfig.similarityThreshold ?? 0.8;

  // Compare files within the same directory scope
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i];
      const b = files[j];

      // Only compare files in the same directory tree (fix I-R3-H6)
      const dirA = path.dirname(a.path);
      const dirB = path.dirname(b.path);
      if (dirA !== dirB && !dirA.startsWith(dirB + '/') && !dirB.startsWith(dirA + '/')) continue;

      const matches = findSimilarParagraphs(a.content, b.content, { threshold });
      for (const match of matches) {
        findings.push({
          ruleId: 'dup/cross-file',
          severity: ruleConfig.severity,
          file: a.path,
          line: match.paraA.line,
          message: `Paragraph similar to ${b.path}:${match.paraB.line} (Jaccard: ${match.score.toFixed(2)}). Consider extracting to a shared doc.`,
          semanticId: semanticId('dup/cross-file', a.path + ':' + b.path, String(match.paraA.line)),
          fixable: false,
        });
      }
    }
  }
}

function checkClaudeAgentsSync(files, ruleConfig, findings) {
  if (!ruleConfig || ruleConfig.severity === 'off') return;

  // Group files by directory
  const byDir = new Map();
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file);
  }

  for (const [dir, dirFiles] of byDir) {
    const claude = dirFiles.find(f => path.basename(f.path).toUpperCase() === 'CLAUDE.MD');
    const agents = dirFiles.find(f => path.basename(f.path).toUpperCase() === 'AGENTS.MD');
    if (!claude || !agents) continue;

    // Extract headings and compare
    const headingsA = extractHeadings(claude.content);
    const headingsB = extractHeadings(agents.content);

    for (const [heading, contentA] of headingsA) {
      if (headingsB.has(heading)) {
        const contentB = headingsB.get(heading);
        if (contentA !== contentB) {
          findings.push({
            ruleId: 'sync/claude-agents',
            severity: ruleConfig.severity,
            file: claude.path,
            line: null,
            message: `Heading "${heading}" exists in both ${claude.path} and ${agents.path} with different content. Consider keeping only in one file.`,
            semanticId: semanticId('sync/claude-agents', claude.path + ':' + agents.path, heading),
            fixable: false,
          });
        }
      }
    }
  }
}

/**
 * Extract heading → content mapping from markdown.
 * @param {string} content
 * @returns {Map<string, string>}
 */
function extractHeadings(content) {
  const headings = new Map();
  const lines = content.split('\n');
  let currentHeading = null;
  let currentContent = [];

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+)/);
    if (m) {
      if (currentHeading) {
        headings.set(currentHeading, currentContent.join('\n').trim());
      }
      currentHeading = m[2].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentHeading) {
    headings.set(currentHeading, currentContent.join('\n').trim());
  }

  return headings;
}
