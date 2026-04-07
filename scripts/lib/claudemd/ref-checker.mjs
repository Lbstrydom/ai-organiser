/**
 * @fileoverview Stale-reference detection for instruction files.
 * Checks file paths, function/class names, and env vars referenced in markdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MANDATORY_EXCLUDES } from './file-scanner.mjs';

/** Platform env vars to skip when checking references. */
const PLATFORM_VARS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'CI', 'GITHUB_TOKEN', 'SHELL', 'USER', 'TERM',
  'PWD', 'LANG', 'EDITOR', 'TMPDIR', 'TMP', 'TEMP',
]);

/** Common function names that are too generic to flag. */
const DEFAULT_IGNORE_FUNCTIONS = new Set(['init', 'run', 'main', 'test', 'setup', 'default']);

/**
 * Resolve a referenced path from an instruction file.
 * @param {string} sourceFile - Repo-relative path of the source file
 * @param {string} rawRef - Raw reference string from markdown
 * @param {string} repoRoot - Absolute repo root
 * @returns {{ resolved: string|null, skip: boolean, reason?: string }}
 */
export function resolveReferencedPath(sourceFile, rawRef, repoRoot) {
  // Skip external URLs and anchors
  if (/^https?:\/\/|^mailto:|^#/.test(rawRef)) return { resolved: null, skip: true, reason: 'external' };

  // Strip trailing anchors and query fragments
  let cleaned = rawRef.replace(/#.*$/, '').replace(/\?.*$/, '').trim();
  if (!cleaned) return { resolved: null, skip: true, reason: 'empty-after-strip' };

  // Resolve relative to source file's directory
  const sourceDir = path.dirname(sourceFile);
  const resolved = path.posix.normalize(path.posix.join(sourceDir, cleaned));

  // Repo boundary check — reject paths that escape the repo root
  if (resolved.startsWith('..')) {
    return { resolved, skip: true, reason: 'escapes-repo-root' };
  }

  const absPath = path.join(repoRoot, resolved);
  return { resolved, skip: false, exists: fs.existsSync(absPath) };
}

/**
 * Extract markdown link references from content.
 * Skips references inside fenced code blocks.
 * @param {string} content
 * @returns {Array<{ ref: string, line: number }>}
 */
export function extractFileRefs(content) {
  const refs = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Markdown links: [text](path)
    const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(line))) {
      refs.push({ ref: match[2], line: i + 1 });
    }

    // Backtick paths matching common extensions
    const backtickPattern = /`([^`]+\.(?:mjs|js|ts|py|json|yml|yaml|md|sql|toml|sh))`/g;
    while ((match = backtickPattern.exec(line))) {
      // Only treat as file ref if it looks like a path (has / or starts with .)
      const val = match[1];
      if (val.includes('/') || val.startsWith('.')) {
        refs.push({ ref: val, line: i + 1 });
      }
    }
  }

  return refs;
}

/**
 * Build an in-process index of exported identifiers from source files.
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function buildFunctionIndex(repoRoot) {
  const index = new Set();
  const excludeDirs = new Set(MANDATORY_EXCLUDES.map(e => e.split('/')[0]));

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(mjs|js|ts|py)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          const lines = content.split('\n');
          for (const line of lines) {
            let m;
            // JS/TS exports
            if ((m = line.match(/export\s+(?:async\s+)?function\s+(\w+)/))) index.add(m[1]);
            if ((m = line.match(/export\s+class\s+(\w+)/))) index.add(m[1]);
            if ((m = line.match(/export\s+const\s+(\w+)/))) index.add(m[1]);
            // Python defs
            if ((m = line.match(/^def\s+(\w+)\s*\(/))) index.add(m[1]);
            if ((m = line.match(/^class\s+(\w+)/))) index.add(m[1]);
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  walk(repoRoot);
  return index;
}

/**
 * Extract function/class references from instruction file content.
 * Looks for backtick-wrapped identifiers.
 * @param {string} content
 * @returns {Array<{ name: string, line: number }>}
 */
export function extractFunctionRefs(content) {
  const refs = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match `functionName()` or `ClassName` patterns
    const pattern = /`(\w+)\(\)`|`(\w+)`/g;
    let match;
    while ((match = pattern.exec(line))) {
      const name = match[1] || match[2];
      // Filter: must look like a function/class name (camelCase, PascalCase, snake_case)
      if (name && /^[a-z_][a-zA-Z0-9_]*$|^[A-Z][a-zA-Z0-9]*$/.test(name)) {
        refs.push({ name, line: i + 1 });
      }
    }
  }

  return refs;
}

/**
 * Extract env var references from instruction file content.
 * @param {string} content
 * @returns {Array<{ name: string, line: number }>}
 */
export function extractEnvVarRefs(content) {
  const refs = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match ALL_CAPS_WITH_UNDERSCORES (≥2 chars, ≥1 underscore)
    const pattern = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
    let match;
    while ((match = pattern.exec(line))) {
      refs.push({ name: match[1], line: i + 1 });
    }
  }

  return refs;
}

/**
 * Build an index of known env vars from .env.example and source code.
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function buildEnvVarIndex(repoRoot) {
  const vars = new Set(PLATFORM_VARS);

  // Read .env.example
  const envExample = path.join(repoRoot, '.env.example');
  if (fs.existsSync(envExample)) {
    const content = fs.readFileSync(envExample, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
      if (m) vars.add(m[1]);
    }
  }

  // Scan source for process.env.VAR / os.environ.get('VAR')
  const excludeDirs = new Set(MANDATORY_EXCLUDES.map(e => e.split('/')[0]));

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(mjs|js|ts|py)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          // process.env.VAR_NAME
          const jsPattern = /process\.env\.([A-Z][A-Z0-9_]+)/g;
          let m;
          while ((m = jsPattern.exec(content))) vars.add(m[1]);
          // os.environ / os.getenv
          const pyPattern = /(?:os\.environ(?:\.get)?\s*\(\s*['"]|os\.getenv\s*\(\s*['"])([A-Z][A-Z0-9_]+)/g;
          while ((m = pyPattern.exec(content))) vars.add(m[1]);
        } catch { /* skip */ }
      }
    }
  }

  walk(repoRoot);
  return vars;
}

export { PLATFORM_VARS, DEFAULT_IGNORE_FUNCTIONS };
