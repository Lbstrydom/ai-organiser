/**
 * @fileoverview Receipt-based drift detection and unmanaged-file checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Compute SHA-256 (first 12 hex chars) of a file.
 * @param {string} absPath
 * @returns {string|null}
 */
export function computeFileSha(absPath) {
  try {
    const content = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Detect conflicts between planned writes and existing files.
 * @param {Array<{ path: string, absPath: string, sha: string }>} plannedWrites - Files to write
 * @param {object|null} receipt - Existing install receipt
 * @param {object} options
 * @param {boolean} [options.force=false]
 * @returns {{ safe: Array, conflicts: Array<{ path: string, reason: string }> }}
 */
export function detectConflicts(plannedWrites, receipt, options = {}) {
  const safe = [];
  const conflicts = [];
  const managedShas = new Map();

  if (receipt?.managedFiles) {
    for (const f of receipt.managedFiles) {
      managedShas.set(f.path, f.sha);
    }
  }

  for (const write of plannedWrites) {
    if (!fs.existsSync(write.absPath)) {
      // File doesn't exist — safe to write
      safe.push(write);
      continue;
    }

    const currentSha = computeFileSha(write.absPath);
    const expectedSha = managedShas.get(write.path);

    if (expectedSha && currentSha === expectedSha) {
      // Managed file, unchanged since last install — safe to overwrite
      safe.push(write);
    } else if (expectedSha && currentSha !== expectedSha) {
      // Managed file but operator modified it
      if (options.force) {
        safe.push(write);
      } else {
        conflicts.push({
          path: write.path,
          reason: `locally modified (receipt SHA: ${expectedSha}, current: ${currentSha}). Use --force to overwrite.`,
        });
      }
    } else {
      // Not in receipt — unmanaged file
      if (options.force) {
        safe.push(write);
      } else {
        conflicts.push({
          path: write.path,
          reason: 'exists but not managed by this installer. Use --force to overwrite or --adopt to claim.',
        });
      }
    }
  }

  return { safe, conflicts };
}

/**
 * Detect local drift: hash every managed file in receipt, compare to expected.
 * @param {object} receipt
 * @param {string} baseDir - Directory where paths are relative to
 * @returns {Array<{ path: string, expected: string, actual: string|null, status: 'match'|'drifted'|'missing' }>}
 */
export function detectDrift(receipt, baseDir) {
  const results = [];
  if (!receipt?.managedFiles) return results;

  for (const f of receipt.managedFiles) {
    const absPath = path.join(baseDir, f.path);
    const actual = computeFileSha(absPath);
    const expected = f.sha || f.blockSha;

    if (!actual) {
      results.push({ path: f.path, expected, actual: null, status: 'missing' });
    } else if (actual === expected) {
      results.push({ path: f.path, expected, actual, status: 'match' });
    } else {
      results.push({ path: f.path, expected, actual, status: 'drifted' });
    }
  }

  return results;
}
