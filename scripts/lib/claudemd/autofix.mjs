/**
 * @fileoverview Conservative auto-fix for CLAUDE.md hygiene findings.
 * Only fixes standalone markdown link nodes (stale/file-ref).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Apply auto-fixes to findings. Only stale/file-ref with standalone links are fixable.
 * @param {Array} findings - Findings from runRules()
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true] - If true, report but don't modify
 * @returns {{ applied: Array<{ file: string, line: number, action: string }>, skipped: Array<{ file: string, line: number, reason: string }> }}
 */
export function applyFixes(findings, repoRoot, options = {}) {
  const dryRun = options.dryRun !== false;
  const applied = [];
  const skipped = [];

  // Group fixable findings by file
  const byFile = new Map();
  for (const f of findings) {
    if (!f.fixable) continue;
    if (f.ruleId !== 'stale/file-ref') continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [filePath, fileFindings] of byFile) {
    // Sort by line descending — splice from bottom up to avoid stale indices
    fileFindings.sort((a, b) => (b.line || 0) - (a.line || 0));
    const absPath = path.join(repoRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    let modified = false;

    for (const finding of fileFindings) {
      if (!finding.line || finding.line < 1 || finding.line > lines.length) {
        skipped.push({ file: filePath, line: finding.line, reason: 'invalid line number' });
        continue;
      }

      const lineIdx = finding.line - 1;
      const line = lines[lineIdx];

      // Only fix standalone markdown links (entire line is a link or list-item link)
      const standaloneLink = /^\s*(?:[-*]\s+)?\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
      if (!standaloneLink) {
        skipped.push({ file: filePath, line: finding.line, reason: 'reference embedded in prose' });
        continue;
      }

      if (dryRun) {
        applied.push({ file: filePath, line: finding.line, action: `would remove: ${line.trim()}` });
      } else {
        lines.splice(lineIdx, 1);
        modified = true;
        applied.push({ file: filePath, line: finding.line, action: `removed: ${line.trim()}` });
      }
    }

    if (modified && !dryRun) {
      // Atomic write
      const tmpPath = absPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, lines.join('\n'));
      fs.renameSync(tmpPath, absPath);
    }
  }

  return { applied, skipped };
}
