/**
 * @fileoverview Discover instruction files in a repo (CLAUDE.md, AGENTS.md, SKILL.md).
 * Mandatory exclusions prevent scanning into node_modules, .git, etc.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Globs that are always excluded (non-configurable). */
const MANDATORY_EXCLUDES = [
  '.git', 'node_modules', 'dist', 'build', 'coverage',
  'tests/**/fixtures', 'vendor', '.next', '__pycache__', '.venv',
];

/** Patterns to scan for instruction files. */
const INSTRUCTION_PATTERNS = [
  '**/CLAUDE.md',
  '**/AGENTS.md',
  '.claude/skills/*/SKILL.md',
  '.github/skills/*/SKILL.md',
  '.github/copilot-instructions.md',
];

/**
 * Simple recursive glob without external dependency.
 * @param {string} dir - Directory to search
 * @param {string} pattern - Filename pattern to match
 * @param {Set<string>} excludeDirs - Directory names to skip
 * @returns {string[]}
 */
function walkDir(dir, patterns, excludeDirs) {
  const results = [];
  const patternNames = patterns.map(p => path.basename(p));

  function walk(current, relPath) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        // Check for fixtures exclusion
        if (entryRel.includes('fixtures')) {
          const parts = entryRel.split('/');
          const testsIdx = parts.indexOf('tests');
          if (testsIdx >= 0 && parts.indexOf('fixtures', testsIdx) >= 0) continue;
        }
        walk(path.join(current, entry.name), entryRel);
      } else if (entry.isFile()) {
        // Match against known instruction file names
        if (patternNames.includes(entry.name)) {
          // Verify it matches one of the full patterns
          for (const p of patterns) {
            if (matchPattern(entryRel, p)) {
              results.push(entryRel);
              break;
            }
          }
        }
      }
    }
  }

  walk(dir, '');
  return results;
}

// Simple pattern matching for our known patterns.
// Supports: exact match, glob-star/name (any directory), dir/wildcard/name (one-level wildcard)
function matchPattern(filePath, pattern) {
  const norm = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  if (pat.startsWith('**/')) {
    // Match filename anywhere
    const name = pat.slice(3);
    return norm === name || norm.endsWith('/' + name);
  }

  // Handle patterns like .claude/skills/*/SKILL.md
  const patParts = pat.split('/');
  const fileParts = norm.split('/');

  if (patParts.length !== fileParts.length) return false;

  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i] === '*') continue;
    if (patParts[i] !== fileParts[i]) return false;
  }
  return true;
}

/**
 * Scan a repository for instruction files.
 * @param {string} repoRoot - Absolute path to repo root
 * @param {object} [options]
 * @param {string[]} [options.additionalExcludes] - Extra globs to exclude
 * @returns {{ files: Array<{ path: string, absPath: string, content: string, sizeBytes: number }> }}
 */
export function scanInstructionFiles(repoRoot, options = {}) {
  const excludeDirs = new Set(MANDATORY_EXCLUDES.map(e => e.split('/')[0]));
  if (options.additionalExcludes) {
    for (const e of options.additionalExcludes) {
      excludeDirs.add(e.split('/')[0]);
    }
  }

  const found = walkDir(repoRoot, INSTRUCTION_PATTERNS, excludeDirs);
  const files = [];

  for (const relPath of found) {
    const absPath = path.join(repoRoot, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      files.push({
        path: relPath.replace(/\\/g, '/'),
        absPath,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      });
    } catch { /* skip unreadable files */ }
  }

  return { files };
}

export { MANDATORY_EXCLUDES, INSTRUCTION_PATTERNS };
