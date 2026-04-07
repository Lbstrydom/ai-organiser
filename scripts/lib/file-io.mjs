/**
 * @fileoverview File I/O utilities extracted from shared.mjs.
 * Handles file reading, writing, path normalization, sensitive file filtering,
 * diff parsing, and context assembly for audit scripts.
 * @module scripts/lib/file-io
 */

import fs from 'fs';
import path from 'path';
import { ALL_EXTENSIONS_PATTERN } from './language-profiles.mjs';

// ── Atomic File Writes ──────────────────────────────────────────────────────
// Write to a temp file in the same directory, then rename for crash-safety.

export function atomicWriteFileSync(filePath, data) {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    // Clean up temp file on failure — log but don't mask the original error
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {
      process.stderr.write(`  [atomic-write] Temp file cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
}

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Canonicalize file paths to cwd-relative, forward-slash, lowercase form.
 * @param {string} p - File path (absolute or relative)
 * @returns {string} Normalized path
 */
export function normalizePath(p) {
  const resolved = path.resolve(p);
  const cwdPrefix = path.resolve('.');
  return resolved.replace(cwdPrefix, '').replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
}

// ── Safe Parsing ────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Sensitive File Filtering ────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\.env$/i, /\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /password/i, /token/i, /\.pfx$/i, /\.p12$/i, /id_rsa/i, /id_ed25519/i
];

export function isSensitiveFile(relPath) {
  const basename = path.basename(relPath);
  return SENSITIVE_PATTERNS.some(p => p.test(basename));
}

// ── Diff Parsing ────────────────────────────────────────────────────────────

/**
 * Parse unified diff into line ranges per file.
 * @param {string} diffPath - Path to unified diff file
 * @returns {Map<string, {hunks: Array<{startLine: number, lineCount: number}>}>}
 */
export function parseDiffFile(diffPath) {
  const absPath = path.resolve(diffPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [diff] File not found: ${absPath}\n`);
    return new Map();
  }

  let content;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`  [diff] Failed to read: ${err.message}\n`);
    return new Map();
  }

  const diffMap = new Map();
  let currentFile = null;

  for (const line of content.split('\n')) {
    // File header: +++ b/path/to/file.js
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      if (!diffMap.has(currentFile)) diffMap.set(currentFile, { hunks: [] });
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      diffMap.get(currentFile).hunks.push({
        startLine: parseInt(hunkMatch[1], 10),
        lineCount: parseInt(hunkMatch[2] || '1', 10)
      });
    }
  }

  process.stderr.write(`  [diff] Parsed ${diffMap.size} files, ${[...diffMap.values()].reduce((s, d) => s + d.hunks.length, 0)} hunks\n`);
  return diffMap;
}

// ── File Reading ────────────────────────────────────────────────────────────

/**
 * Read file contents, truncated per file, capped total.
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string}
 */
export function readFilesAsContext(filePaths, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;

  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; continue; }

    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary)) { omitted++; continue; }
    if (!fs.existsSync(absPath)) continue;

    const raw = fs.readFileSync(absPath, 'utf-8');
    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';
    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;
    const block = `### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  if (sensitive > 0) total += `\n... [${sensitive} sensitive file(s) excluded (.env, secrets, keys)]\n`;
  return total;
}

/**
 * Wraps readFilesAsContext with diff-based change markers.
 * @param {string[]} filePaths - Files to read
 * @param {Map} diffMap - Output of parseDiffFile()
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string} Annotated file context
 */
export function readFilesAsAnnotatedContext(filePaths, diffMap, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) continue;
    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary) || !fs.existsSync(absPath)) continue;

    let raw = fs.readFileSync(absPath, 'utf-8');
    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';

    // Apply diff annotations if this file has changes
    const normPath = normalizePath(relPath);
    const diffInfo = diffMap?.get(normPath);
    if (diffInfo && diffInfo.hunks.length > 0) {
      const lines = raw.split('\n');
      // Insert markers (reverse order to preserve line numbers)
      const sortedHunks = [...diffInfo.hunks].sort((a, b) => b.startLine - a.startLine);
      for (const hunk of sortedHunks) {
        const endLine = Math.min(hunk.startLine + hunk.lineCount - 1, lines.length);
        const startIdx = Math.max(hunk.startLine - 1, 0);
        lines.splice(endLine, 0, '// ── END CHANGED ──');
        lines.splice(startIdx, 0, '// ── CHANGED ──');
      }
      raw = lines.join('\n');
    }

    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;

    const annotation = diffInfo ? ' [CHANGED]' : '';
    const block = `### ${relPath}${annotation}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  return total;
}

// ── File Path Extraction ────────────────────────────────────────────────────

/**
 * Extract source file paths from a plan. Purely regex-driven.
 * @param {string} planContent
 * @returns {{found: string[], missing: string[], allPaths: Set<string>}}
 */
export function extractPlanPaths(planContent) {
  const paths = new Set();
  let match;

  const EXT = 'js|mjs|ts|tsx|jsx|sql|css|html|json|md|py|rs|go|java|rb|sh';

  // Phase 1: Exact path regex extraction (backtick paths, inline paths, heading filenames)
  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  // Allow slash-containing paths AND bare filenames: #### `src/app/main.py` or #### `file.py`
  // Extension list comes from the language-profiles registry (single source of truth).
  const fnRegex = new RegExp(`####\\s+\`([\\w./-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))\``, 'gm');
  while ((match = fnRegex.exec(planContent)) !== null) {
    const captured = match[1];
    // If captured path contains a slash, treat it as repo-relative and add directly
    if (captured.includes('/')) {
      const normalized = captured.replace(/^\.\//, '');
      if (!normalized.startsWith('http') && !normalized.startsWith('node_modules')) paths.add(normalized);
      continue;
    }
    // Bare filename — use search-dir fuzzy discovery (existing behavior)
    const filename = captured;
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate))) { paths.add(candidate); break; }
    }
  }

  // Phase 2: Fuzzy keyword discovery — only when Phase 1 found very few files.
  // Catches cases where plan says "UserService" but file is "user-service.ts".
  const regexFoundCount = [...paths].filter(p => fs.existsSync(path.resolve(p))).length;
  if (regexFoundCount < 5) {
    const keywords = _extractPlanKeywords(planContent);
    if (keywords.length > 0) {
      const repoFiles = _scanRepoFiles();
      const beforeCount = paths.size;
      for (const file of repoFiles) {
        const basename = path.basename(file).toLowerCase().replace(/\.[^.]+$/, '').replaceAll(/[._-]/g, '');
        if (basename.length < 3) continue;
        for (const kw of keywords) {
          // Require strong match: keyword ≥6 chars and covers ≥50% of the basename
          if (kw.length >= 6 && basename.includes(kw) && kw.length >= basename.length * 0.5) {
            paths.add(file);
            break;
          }
        }
      }
      const added = paths.size - beforeCount;
      if (added > 0) {
        process.stderr.write(`  [plan-paths] Fuzzy discovery: +${added} files from ${keywords.length} plan keywords\n`);
      }
    }
  }

  const resolved = new Map();
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!resolved.has(abs)) resolved.set(abs, p);
  }

  const found = [];
  const missing = [];
  for (const p of [...resolved.values()].sort()) {
    (fs.existsSync(path.resolve(p)) ? found : missing).push(p);
  }
  return { found, missing, allPaths: new Set(resolved.values()) };
}

/**
 * Extract keywords from plan text that likely refer to implementation files.
 * Catches: PascalCase names (UserService), backtick identifiers, heading references.
 * @param {string} planContent
 * @returns {string[]} Lowercase keywords
 */
function _extractPlanKeywords(planContent) {
  const keywords = new Set();

  // PascalCase identifiers (e.g. UserService, AuthMiddleware, WineCellar)
  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = pascalRegex.exec(planContent)) !== null) {
    // Split PascalCase into parts: "UserService" → "userservice"
    keywords.add(m[1].toLowerCase());
    // Also add individual parts: "user", "service"
    const parts = m[1].replace(/([A-Z])/g, ' $1').trim().split(/\s+/);
    for (const part of parts) {
      if (part.length >= 4) keywords.add(part.toLowerCase());
    }
  }

  // Backtick identifiers that look like module/class names (not paths — those are caught in Phase 1)
  const btIdentRegex = /`([A-Za-z][\w]+)`/g;
  while ((m = btIdentRegex.exec(planContent)) !== null) {
    const ident = m[1];
    // Skip if it looks like a path (has slashes or dots before extension)
    if (ident.includes('/') || /\.\w{1,4}$/.test(ident)) continue;
    if (ident.length >= 4) keywords.add(ident.toLowerCase());
  }

  // Heading references: "### Authentication Service" → "authentication", "service"
  const headingRegex = /^#{2,4}\s+(.+)$/gm;
  while ((m = headingRegex.exec(planContent)) !== null) {
    const words = m[1].replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
    for (const w of words) {
      if (w.length >= 4) keywords.add(w.toLowerCase());
    }
  }

  // Remove common noise words
  const noise = new Set([
    'this', 'that', 'with', 'from', 'will', 'should', 'must', 'have', 'been',
    'when', 'where', 'what', 'which', 'each', 'every', 'some', 'many', 'more',
    'than', 'then', 'into', 'also', 'only', 'over', 'such', 'both', 'after',
    'before', 'other', 'about', 'between', 'through', 'during', 'without',
    'within', 'along', 'following', 'across', 'behind', 'beyond', 'plus',
    'implementation', 'overview', 'summary', 'approach', 'architecture',
    'design', 'pattern', 'context', 'example', 'notes', 'details',
    'step', 'phase', 'plan', 'task', 'issue', 'error', 'status',
    'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
    'function', 'class', 'const', 'export', 'import', 'async', 'await',
    'return', 'default', 'interface', 'type'
  ]);
  return [...keywords].filter(kw => !noise.has(kw) && kw.length >= 3);
}

/**
 * Scan the working directory for source files, respecting common ignore patterns.
 * Returns relative paths. Limits depth to 5 levels and skips node_modules, .git, dist, build.
 * @returns {string[]} Relative file paths
 */
function _scanRepoFiles() {
  const EXT_SET = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.sql', '.css', '.html', '.json', '.py', '.rs', '.go', '.java', '.rb', '.sh', '.vue', '.svelte']);
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.tox', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv', '.claude', '.github', 'docs']);
  const results = [];

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_SET.has(ext) && !isSensitiveFile(entry.name)) {
          const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
          results.push(rel);
        }
      }
    }
  }

  walk(process.cwd(), 0);
  return results;
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify files as backend, frontend, or shared.
 * @param {string[]} filePaths
 * @returns {{backend: string[], frontend: string[], shared: string[]}}
 */
export function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p);
    }
  }

  return { backend, frontend, shared };
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout.
 * @param {object} data
 * @param {string} outPath
 * @param {string} summaryLine
 */
export function writeOutput(data, outPath, summaryLine) {
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
    process.stderr.write(`  [out] Results written to ${abs}\n`);
    console.log(summaryLine);
  } else {
    console.log(json);
  }
}
