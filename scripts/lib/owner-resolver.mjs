/**
 * @fileoverview Phase D.5 — CODEOWNERS resolver.
 *
 * Resolves the owner of a debt entry's first affected file. Tries in order:
 *   1. Explicit --owner arg at defer-time → wins
 *   2. CODEOWNERS match (last-wins GitHub semantics) at .github/CODEOWNERS,
 *      CODEOWNERS at repo root, or docs/CODEOWNERS
 *   3. Returns undefined → debt-review groups as "unassigned"
 *
 * Uses the `codeowners-utils` package for parsing + matching to avoid
 * reimplementing GitHub's CODEOWNERS semantics (wildcards, last-match-wins,
 * @team vs @user, email owners).
 *
 * @module scripts/lib/owner-resolver
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse, matchFile } from 'codeowners-utils';

/** CODEOWNERS path candidates, in GitHub's documented precedence order. */
const CODEOWNERS_CANDIDATES = Object.freeze([
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
]);

// Cache parsed entries so repeated resolveOwner() calls don't re-read the file.
let _codeownersCache = null;
let _codeownersPath = null;

/**
 * Find the first CODEOWNERS file that exists in the repo. Returns its path
 * or null if none found.
 * @param {string} [rootDir] - Defaults to process.cwd()
 * @returns {string|null}
 */
export function findCodeownersFile(rootDir = process.cwd()) {
  for (const candidate of CODEOWNERS_CANDIDATES) {
    const full = path.resolve(rootDir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Load + parse CODEOWNERS from disk, with in-process caching.
 * @param {string} [rootDir]
 * @returns {Array<{pattern: string, owners: string[]}>|null}
 */
export function loadCodeownersEntries(rootDir = process.cwd()) {
  const filePath = findCodeownersFile(rootDir);
  if (!filePath) {
    _codeownersCache = null;
    _codeownersPath = null;
    return null;
  }
  // Cache by path — if path changes (different repo), re-read
  if (_codeownersCache && _codeownersPath === filePath) return _codeownersCache;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    _codeownersCache = parse(content);
    _codeownersPath = filePath;
    return _codeownersCache;
  } catch (err) {
    process.stderr.write(`  [owner-resolver] failed to load ${filePath}: ${err.message}\n`);
    return null;
  }
}

/**
 * Reset the cache — test-only hook.
 * @internal
 */
export function _resetCache() {
  _codeownersCache = null;
  _codeownersPath = null;
}

/**
 * Resolve the primary owner for a file path. Returns the first owner of the
 * matching CODEOWNERS rule, or undefined if no rule matches.
 *
 * @param {string} filePath - Repo-relative path (forward-slash normalized)
 * @param {object} [opts]
 * @param {string} [opts.explicitOwner] - Overrides CODEOWNERS lookup
 * @param {string} [opts.rootDir] - For testing: override repo root
 * @returns {string|undefined}
 */
export function resolveOwner(filePath, { explicitOwner, rootDir } = {}) {
  if (explicitOwner) return explicitOwner;
  if (!filePath) return undefined;

  const entries = loadCodeownersEntries(rootDir);
  if (!entries || entries.length === 0) return undefined;

  // Normalize path: codeowners-utils expects forward slashes, no leading slash
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.?\//, '');
  try {
    const match = matchFile(normalized, entries);
    return match?.owners?.[0];
  } catch (err) {
    process.stderr.write(`  [owner-resolver] match failed for ${normalized}: ${err.message}\n`);
    return undefined;
  }
}

/**
 * Resolve owners for a list of files in one pass (batch-efficient).
 * @param {string[]} filePaths
 * @param {object} [opts]
 * @returns {Map<string, string|undefined>}
 */
export function resolveOwners(filePaths, opts = {}) {
  const result = new Map();
  for (const fp of filePaths) {
    result.set(fp, resolveOwner(fp, opts));
  }
  return result;
}
