/**
 * @fileoverview Two-phase install commit with snapshot + rollback.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Execute a two-phase install transaction.
 * 1. Snapshot existing files
 * 2. Write all files atomically
 * 3. If any write fails, rollback all from snapshots
 *
 * @param {Array<{ absPath: string, content: string|Buffer }>} writes
 * @returns {{ success: boolean, written: number, error?: string }}
 */
export function executeTransaction(writes) {
  // Phase 1: snapshot existing files
  const snapshots = new Map();
  for (const w of writes) {
    if (fs.existsSync(w.absPath)) {
      try {
        snapshots.set(w.absPath, fs.readFileSync(w.absPath));
      } catch {
        snapshots.set(w.absPath, null); // Couldn't read — will skip on rollback
      }
    } else {
      snapshots.set(w.absPath, undefined); // File didn't exist
    }
  }

  // Phase 2: write all files
  const written = [];
  try {
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.absPath), { recursive: true });
      const tmpPath = w.absPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, w.content);
      fs.renameSync(tmpPath, w.absPath);
      written.push(w.absPath);
    }
    return { success: true, written: written.length };
  } catch (err) {
    // Rollback: restore from snapshots
    for (const absPath of written) {
      const snapshot = snapshots.get(absPath);
      try {
        if (snapshot === undefined) {
          // File didn't exist before — delete it
          fs.unlinkSync(absPath);
        } else if (snapshot !== null) {
          // Restore original content
          const tmpPath = absPath + '.tmp.' + process.pid;
          fs.writeFileSync(tmpPath, snapshot);
          fs.renameSync(tmpPath, absPath);
        }
      } catch (rollbackErr) {
          process.stderr.write(`  [rollback] Failed to restore ${absPath}: ${rollbackErr.message}\n`);
        }
    }
    return { success: false, written: 0, error: err.message };
  }
}
