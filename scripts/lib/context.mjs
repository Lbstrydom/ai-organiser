/**
 * @fileoverview Project context and repo profiling utilities.
 * Handles CLAUDE.md reading, audit brief generation (LLM-assisted),
 * repo scanning/profiling, pass-specific context extraction, and history building.
 * @module scripts/lib/context
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { normalizePath, isSensitiveFile, readFileOrDie } from './file-io.mjs';
import { estimateTokens } from './code-analysis.mjs';
import { semanticId, setRepoProfileCache } from './findings.mjs';

// ── Module-Level Caches ─────────────────────────────────────────────────────

let _repoProfileCache = null;
let _auditBriefCache = null;
let _claudeMdCache = null;

/** Get the cached repo profile (or null if not yet generated). */
export function getRepoProfileCache() {
  return _repoProfileCache;
}

/** Get the cached audit brief (or null if not yet generated). */
export function getAuditBriefCache() {
  return _auditBriefCache;
}

/** Get the cached CLAUDE.md content (or null if not yet read). */
export function getClaudeMdCache() {
  return _claudeMdCache;
}

// ── Private Helpers ─────────────────────────────────────────────────────────

/**
 * Read and cache the project's instruction file (CLAUDE.md, Agents.md, etc.).
 * @returns {string} File content, or empty string if not found
 */
function _getClaudeMd() {
  if (_claudeMdCache !== null) return _claudeMdCache;
  for (const name of ['CLAUDE.md', 'Agents.md', '.github/copilot-instructions.md']) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) {
      _claudeMdCache = fs.readFileSync(p, 'utf-8');
      return _claudeMdCache;
    }
  }
  _claudeMdCache = '';
  return _claudeMdCache;
}

/**
 * Helper: get the path of the found instruction file (not the content).
 * @returns {string|null} Path to instruction file, or null
 */
function _getClaudeMdPath() {
  for (const name of ['CLAUDE.md', 'Agents.md', '.github/copilot-instructions.md']) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Phase A: Regex pre-extraction of structured facts from CLAUDE.md.
 * Deterministic, zero-cost, works offline. Returns dep versions + stack info.
 * @param {string} content - Raw CLAUDE.md content
 * @returns {string} Structured facts (~200-500 chars)
 */
function _extractRegexFacts(content) {
  const facts = [];

  // 1. Stack/runtime line
  const stackMatch = content.match(/\*\*(?:Stack|Runtime|Purpose)\*\*:\s*(.+)/i);
  if (stackMatch) facts.push(`Stack: ${stackMatch[1].trim()}`);

  // 2. Dependencies from markdown tables: | package | version | ...
  const depLines = [];
  // Match dep table rows: | package | version | notes |
  // Version must start with a digit or ^/~ (excludes prose like "5-pass" or headers)
  const tableRowRegex = /\|\s*`?(@?[\w/.-]+)`?\s*\|\s*\*?\*?([~^]?\d+\.\d+[\d.]*\S*)\*?\*?\s*\|(.*)$/gm;
  let match;
  while ((match = tableRowRegex.exec(content)) !== null) {
    const pkg = match[1].trim();
    const ver = match[2].trim();
    const notes = match[3].replace(/\|/g, '').trim();
    // Skip table headers
    if (pkg === 'Package' || pkg === 'Variable' || ver === 'Version' || /^-+$/.test(ver)) continue;
    const line = notes ? `${pkg}@${ver} — ${notes.slice(0, 80)}` : `${pkg}@${ver}`;
    depLines.push(line);
  }
  // Also check inline bold format: **package**: version
  // Package must contain lowercase letter (excludes metrics like MRR, HIT@1)
  // Version must have at least one dot (excludes bare numbers)
  const inlineDepRegex = /\*\*(`?[\w@/.-]+`?)\*\*:\s*(?:version\s+)?(\d+\.\d+[\d.]*\S*)/gi;
  while ((match = inlineDepRegex.exec(content)) !== null) {
    const pkg = match[1].replace(/`/g, '');
    const ver = match[2];
    if (/[a-z]/.test(pkg) && !depLines.some(l => l.startsWith(pkg))) depLines.push(`${pkg}@${ver}`);
  }
  if (depLines.length > 0) facts.push(`Dependencies:\n${depLines.map(l => `  ${l}`).join('\n')}`);

  // 3. Fallback: read package.json if no deps found
  if (depLines.length === 0) {
    try {
      const pkgPath = path.resolve('package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const pkgLines = Object.entries(deps).slice(0, 15).map(([k, v]) => `  ${k}@${v}`);
        if (pkgLines.length > 0) facts.push(`Dependencies (from package.json):\n${pkgLines.join('\n')}`);
      }
    } catch { /* ignore */ }
  }

  return facts.join('\n');
}

const BRIEF_SYSTEM_PROMPT = `You are extracting an audit brief from a project's developer guidelines document.
Produce a CONCISE reference that a code auditor needs to avoid false positives.

## What to extract (use these exact headings):

### Dependencies & Versions
List every dependency with its EXACT version and any API-breaking notes (e.g., "Zod 4 uses _def.type NOT _def.typeName").

### Coding Rules
- Required patterns (async/await, scoping, auth, database query patterns)
- Forbidden patterns (things marked "Do NOT", "Never", "WRONG")
- Critical constraints (sections marked "CRITICAL")

### Architecture
- How modules interact (1-2 sentences)
- Key invariants (e.g., "all queries must include cellar_id")

### Naming Conventions
- File, variable, function, CSS naming rules (one line each)

### Testing
- Test commands and key rules (mock patterns, isolation)

## Rules
- Be THOROUGH — include ALL do/don't rules, not just the first few
- Include exact version numbers — auditors need these to avoid false positives
- No deployment instructions, environment variables, MCP configs, or Git conventions
- No code examples — just the rules/patterns
- Target 800-1200 characters`;

/**
 * Phase B: LLM condensation of CLAUDE.md into audit-relevant facts.
 * Fallback chain: Claude Haiku -> Gemini Flash -> null.
 * Haiku is primary (better quality, captures all constraints).
 * @param {string} content - Raw CLAUDE.md content (will be truncated)
 * @returns {Promise<string|null>} LLM-generated brief, or null on failure
 */
async function _llmCondense(content) {
  const truncated = content.slice(0, 48000); // ~12K tokens, fits Haiku/Flash comfortably
  const userContent = `Extract an audit brief from this developer guidelines document:\n\n${truncated}`;

  // Try Claude Haiku first (better quality — captures all constraints)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.BRIEF_MODEL_CLAUDE || 'claude-haiku-4-5-20251001';
      process.stderr.write(`  [brief] Generating via ${model}...\n`);
      const startMs = Date.now();
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      });
      const text = response.content?.[0]?.text?.trim();
      process.stderr.write(`  [brief] ${model} done in ${((Date.now() - startMs) / 1000).toFixed(1)}s (${text?.length ?? 0} chars)\n`);
      if (text && text.length > 100) return text.slice(0, 3000); // Cap at 3000 chars
    } catch (err) {
      process.stderr.write(`  [brief] Claude Haiku failed: ${err.message} — trying Gemini Flash\n`);
    }
  }

  // Fallback: Gemini Flash
  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = process.env.BRIEF_MODEL_GEMINI || 'gemini-2.5-flash';
      process.stderr.write(`  [brief] Generating via ${model}...\n`);
      const startMs = Date.now();
      const response = await ai.models.generateContent({
        model,
        contents: userContent,
        config: {
          systemInstruction: BRIEF_SYSTEM_PROMPT,
          maxOutputTokens: 4000
        }
      });
      const text = response.text?.trim();
      process.stderr.write(`  [brief] ${model} done in ${((Date.now() - startMs) / 1000).toFixed(1)}s (${text?.length ?? 0} chars)\n`);
      if (text && text.length > 100) return text.slice(0, 3000);
    } catch (err) {
      process.stderr.write(`  [brief] Gemini Flash failed: ${err.message}\n`);
    }
  }

  return null; // Both failed — caller uses regex-only
}

// ── Pass-Specific Addendum ───────────────────────────────────────────────────

const PASS_ADDENDUM_PATTERNS = {
  structure: ['Code Organisation'],
  wiring: ['API Design'],
  backend: ['Data Integrity', 'Multi-User', 'PostgreSQL'],
  frontend: ['Frontend Patterns', 'Content Security Policy'],
  sustainability: ['Testing'],
  plan: [],
  rebuttal: [],
  review: []
};

/**
 * Extract a small pass-specific addendum from the raw CLAUDE.md.
 * Supplements the brief with details only relevant to one pass.
 * @param {string} passName
 * @returns {string} ~200-500 chars of pass-specific context, or empty string
 */
function _getPassAddendum(passName) {
  const content = _getClaudeMd();
  if (!content) return '';

  const patterns = PASS_ADDENDUM_PATTERNS[passName];
  if (!patterns || patterns.length === 0) return '';

  const sections = [];
  for (const pat of patterns) {
    const regex = new RegExp(`(## ${pat}[\\s\\S]*?)(?=\\n## [A-Z]|$)`, 'i');
    const match = content.match(regex);
    if (match) sections.push(match[1].slice(0, 500));
  }
  return sections.join('\n\n').slice(0, 800);
}

// ── Exported Functions ──────────────────────────────────────────────────────

/**
 * Generate a repo profile for audit tuning.
 * Combines file system scanning (instant) with audit brief analysis.
 * Cached per session.
 * @returns {object} Repo profile with stack, file breakdown, pass relevance, focus areas
 */
export function generateRepoProfile() {
  if (_repoProfileCache) return _repoProfileCache;

  // 1. File inventory by directory pattern
  const codeExts = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.sql', '.py', '.go', '.rs', '.java', '.rb'];
  const allFiles = [];

  function scanDir(dir, depth = 0) {
    if (depth > 5) return; // Max recursion depth
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else if (codeExts.some(ext => entry.name.endsWith(ext))) {
          allFiles.push(path.relative(path.resolve('.'), fullPath).replace(/\\/g, '/'));
        }
      }
    } catch { /* permission errors, etc */ }
  }
  scanDir(path.resolve('.'));

  // 2. Classify files
  const fileBreakdown = { backend: 0, frontend: 0, config: 0, test: 0, total: allFiles.length };
  for (const f of allFiles) {
    if (/test|spec|__test__|fixture|benchmark/i.test(f)) fileBreakdown.test++;
    else if (/public\/|frontend\/|client\/|\.css$|\.html$/i.test(f)) fileBreakdown.frontend++;
    else if (/config\/|\.config\.|\.env\.|settings/i.test(f)) fileBreakdown.config++;
    else fileBreakdown.backend++;
  }

  // 3. Stack detection from package.json
  const stack = { backend: {}, frontend: {}, testing: {} };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Backend framework
    if (allDeps.express) stack.backend.framework = 'express';
    else if (allDeps.fastify) stack.backend.framework = 'fastify';
    else if (allDeps.koa) stack.backend.framework = 'koa';
    else if (allDeps.hono) stack.backend.framework = 'hono';

    // Database
    if (allDeps.pg || allDeps['@supabase/supabase-js']) stack.backend.db = 'postgresql';
    else if (allDeps.mysql2) stack.backend.db = 'mysql';
    else if (allDeps.mongoose || allDeps.mongodb) stack.backend.db = 'mongodb';
    else if (allDeps['better-sqlite3'] || allDeps.sqlite3) stack.backend.db = 'sqlite';

    // Frontend framework
    if (allDeps.react || allDeps['react-dom']) stack.frontend.framework = 'react';
    else if (allDeps.vue) stack.frontend.framework = 'vue';
    else if (allDeps.svelte) stack.frontend.framework = 'svelte';
    else if (allDeps.angular || allDeps['@angular/core']) stack.frontend.framework = 'angular';
    else if (fileBreakdown.frontend > 0) stack.frontend.framework = 'vanilla-js';

    // Testing
    if (allDeps.vitest) stack.testing.framework = 'vitest';
    else if (allDeps.jest) stack.testing.framework = 'jest';
    else if (allDeps.mocha) stack.testing.framework = 'mocha';

    // TypeScript
    if (allDeps.typescript || allFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      stack.backend.typescript = true;
    }
  } catch { /* no package.json */ }

  // 4. Pass relevance
  const passRelevance = {
    structure: true, // always useful
    wiring: fileBreakdown.frontend > 0 && fileBreakdown.backend > 0, // only if both exist
    backend: fileBreakdown.backend > 0,
    frontend: fileBreakdown.frontend > 0,
    sustainability: true // always useful
  };

  // 5. Focus areas from audit brief (if available)
  const brief = _auditBriefCache || '';
  const focusAreas = [];
  // Extract bullet points from the brief that contain keywords like "MUST", "CRITICAL", "NEVER", "always"
  const briefLines = brief.split('\n');
  for (const line of briefLines) {
    const trimmed = line.replace(/^[-*•]\s*/, '').trim();
    if (trimmed.length > 20 && trimmed.length < 200 && /\b(MUST|CRITICAL|NEVER|always|required|forbidden)\b/i.test(trimmed)) {
      focusAreas.push(trimmed);
    }
  }

  // 6. Fingerprint
  let fingerprint = 'unknown';
  try {
    const parts = [];
    const pkgPath = path.resolve('package.json');
    if (fs.existsSync(pkgPath)) parts.push(fs.readFileSync(pkgPath, 'utf-8'));
    const claudePath = _getClaudeMdPath();
    if (claudePath) parts.push(fs.readFileSync(claudePath, 'utf-8'));
    parts.push(allFiles.sort().join('\n')); // sorted file inventory
    fingerprint = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  } catch { /* */ }

  _repoProfileCache = {
    repoFingerprint: fingerprint,
    stack,
    fileBreakdown,
    passRelevance,
    focusAreas: focusAreas.slice(0, 10), // cap at 10
    codeFiles: allFiles
  };

  // Sync cache to findings module so appendOutcome can access repoFingerprint
  setRepoProfileCache(_repoProfileCache);

  process.stderr.write(`  [repo-profile] ${allFiles.length} files (${fileBreakdown.backend} BE, ${fileBreakdown.frontend} FE, ${fileBreakdown.test} test)\n`);
  process.stderr.write(`  [repo-profile] Stack: ${JSON.stringify(stack.backend)} | Passes: ${Object.entries(passRelevance).filter(([,v]) => v).map(([k]) => k).join(', ')}\n`);
  if (focusAreas.length > 0) process.stderr.write(`  [repo-profile] Focus: ${focusAreas.length} priority rules\n`);

  return _repoProfileCache;
}

/**
 * Initialize the audit brief. Call once at startup before any passes run.
 * Generates a compact context brief from the project's CLAUDE.md using:
 *   Phase A: Regex extraction of deps/versions (deterministic)
 *   Phase B: LLM condensation of constraints/rules (Gemini Flash -> Claude Haiku)
 *   Fallback: regex + raw truncation if no LLM available
 * @returns {Promise<string>} The generated brief
 */
export async function initAuditBrief() {
  const content = _getClaudeMd();
  if (!content) {
    _auditBriefCache = '(No project instruction file found — checked CLAUDE.md, Agents.md, .github/copilot-instructions.md)';
    return _auditBriefCache;
  }

  // Phase A: deterministic regex facts
  const regexFacts = _extractRegexFacts(content);

  // Phase B: LLM condensation
  const llmBrief = await _llmCondense(content);

  if (llmBrief) {
    // Merge: regex facts (trusted) + LLM brief (flexible)
    _auditBriefCache = regexFacts
      ? `## Project Facts (verified)\n${regexFacts}\n\n## Audit Guidelines\n${llmBrief}`
      : `## Audit Guidelines\n${llmBrief}`;
  } else if (regexFacts && regexFacts.length > 200) {
    // Regex-only: good enough for repos with standard structure
    process.stderr.write(`  [brief] No LLM available — using regex-only brief\n`);
    _auditBriefCache = `## Project Facts\n${regexFacts}\n\n## Raw Context\n${content.slice(0, 1500)}`;
  } else {
    // Last resort: raw truncation (same as old behavior)
    process.stderr.write(`  [brief] No LLM, minimal regex — falling back to raw context\n`);
    _auditBriefCache = content.slice(0, 2000);
  }

  process.stderr.write(`  [brief] Final brief: ${_auditBriefCache.length} chars (~${Math.ceil(_auditBriefCache.length / 4)} tokens)\n`);
  return _auditBriefCache;
}

/**
 * Get project context for a specific audit pass.
 * Returns cached brief + pass-specific addendum.
 * Must call initAuditBrief() before first use.
 * @param {string} passName
 * @returns {string}
 */
export function readProjectContextForPass(passName) {
  const brief = _auditBriefCache;
  if (!brief) {
    // initAuditBrief() wasn't called — fall back to old behavior
    const content = _getClaudeMd();
    return content ? content.slice(0, 2000) : '(No project instruction file found — checked CLAUDE.md, Agents.md, .github/copilot-instructions.md)';
  }
  if (brief.startsWith('(No CLAUDE.md')) return brief;

  const addendum = _getPassAddendum(passName);
  return addendum
    ? `${brief}\n\n### Pass-Specific Context\n${addendum}`
    : brief;
}

/** Full project context for single-call modes (plan, rebuttal, review). */
export function readProjectContext() {
  if (_auditBriefCache) return _auditBriefCache;
  const content = _getClaudeMd();
  return content ? content.slice(0, 4000) : '(No project instruction file found — auditing without project context)';
}

/**
 * Extract plan sections relevant to a specific audit pass.
 * @param {string} planContent - Full plan text
 * @param {string} passName - structure|wiring|backend|frontend|sustainability
 * @returns {string}
 */
export function extractPlanForPass(planContent, passName) {
  const sectionPatterns = {
    structure: ['File.Level Plan', 'Architecture', 'Files', 'Structure'],
    wiring: ['API', 'Route', 'Endpoint', 'Contract', 'Wiring'],
    backend: ['Backend', 'Database', 'Service', 'Logic', 'Schema'],
    frontend: ['Frontend', 'UI', 'User Flow', 'Component', 'Layout', 'UX'],
    sustainability: ['Sustainability', 'Testing', 'Risk', 'Trade.off', 'Error']
  };

  const patterns = sectionPatterns[passName];
  if (!patterns) return planContent.length > 4000 ? planContent.slice(0, 4000) : planContent;

  const sections = [];
  for (const pat of patterns) {
    const regex = new RegExp(`(##+ .*${pat}[\\s\\S]*?)(?=\\n##+ |$)`, 'i');
    const match = planContent.match(regex);
    if (match) sections.push(match[1]);
  }

  if (sections.length > 0) {
    const combined = sections.join('\n\n');
    return combined.length > 4000 ? combined.slice(0, 4000) + '\n...[truncated]' : combined;
  }
  return planContent.length > 3000 ? planContent.slice(0, 3000) + '\n...[plan truncated]' : planContent;
}

/**
 * Build a compact audit history block from a history JSON file.
 * @param {string} historyPath - Path to history JSON file
 * @returns {string}
 */
export function buildHistoryContext(historyPath) {
  if (!historyPath) return '';
  const abs = path.resolve(historyPath);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`  [history] File not found: ${abs} — proceeding without history\n`);
    return '';
  }

  let rounds;
  try {
    rounds = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [history] Failed to parse: ${err.message}\n`);
    return '';
  }

  if (!Array.isArray(rounds) || rounds.length === 0) return '';

  const lines = ['## Prior Audit History (DO NOT re-raise resolved items)\n'];
  lines.push(`${rounds.length} prior round(s). Only raise GENUINELY NEW or UNFIXED findings.\n`);

  for (const round of rounds) {
    lines.push(`### Round ${round.round ?? '?'}`);
    const findings = round.findings ?? [];
    if (findings.length > 0) {
      lines.push(`Findings (${findings.length}):`);
      for (const f of findings) {
        const hash = f._hash ?? semanticId(f);
        lines.push(`  ${f.id} [${f.severity}] (hash:${hash}) ${(f.detail ?? f.category ?? '').slice(0, 120)}`);
      }
    }
    if (round.fixed_ids?.length) lines.push(`Fixed: ${round.fixed_ids.join(', ')}`);
    if (round.fixed_hashes?.length) lines.push(`Fixed hashes: ${round.fixed_hashes.join(', ')}`);
    if (round.dismissed_ids?.length) lines.push(`Dismissed: ${round.dismissed_ids.join(', ')}`);
    if (round.dismissed_hashes?.length) lines.push(`Dismissed hashes: ${round.dismissed_hashes.join(', ')}`);
    if (round.resolutions?.length) {
      for (const r of round.resolutions) lines.push(`  ${r.finding_id}: ${r.gpt_ruling} → ${r.final_severity}`);
    }
    lines.push('');
  }

  lines.push('IMPORTANT: Do NOT re-raise findings whose hash appears in Fixed or Dismissed lists above.');
  lines.push('Use semantic hashes (not human IDs) as the primary key for cross-round matching.\n');
  const block = lines.join('\n');
  process.stderr.write(`  [history] Loaded ${rounds.length} round(s), ${block.length} chars\n`);
  return block;
}
