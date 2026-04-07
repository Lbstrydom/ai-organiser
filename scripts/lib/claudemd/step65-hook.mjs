/**
 * @fileoverview Step 6.5 orchestrator integration for CLAUDE.md hygiene.
 * Runs the claudemd-lint CLI, parses the report, returns structured findings
 * for the convergence card and Step 7 transcript.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run the hygiene linter as a Step 6.5 hook.
 * @param {string} sessionId - Audit session ID
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ exitCode: number, report: object|null, summary: string }}
 */
export function runHygieneCheck(sessionId, repoRoot = process.cwd()) {
  const outFile = path.join(process.env.TEMP || '/tmp', `${sessionId}-hygiene.json`);
  const scriptPath = path.join(repoRoot, 'scripts', 'claudemd-lint.mjs');

  // Check if linter exists
  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(`  [hygiene] linter not found, skipping Step 6.5\n`);
    return { exitCode: -1, report: null, summary: 'HYGIENE_SKIPPED (linter not found)' };
  }

  let exitCode;
  try {
    execFileSync(process.execPath, [scriptPath, '--format', 'json', '--out', outFile], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    exitCode = 0;
  } catch (err) {
    exitCode = err.status ?? 3;
  }

  // Parse report
  let report = null;
  if (fs.existsSync(outFile)) {
    try {
      report = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    } catch (e) {
      process.stderr.write(`  [hygiene] failed to parse report: ${e.message}\n`);
    }
  }

  // Build summary
  let summary;
  if (exitCode === -1) {
    summary = 'HYGIENE_SKIPPED';
  } else if (exitCode === 0) {
    summary = 'HYGIENE_CLEAN';
  } else if (exitCode === 3) {
    summary = 'HYGIENE_CRASHED';
    process.stderr.write(`  [hygiene] linter crashed (exit 3), proceeding\n`);
  } else if (report) {
    const s = report.summary;
    summary = `HYGIENE: ${s.error} error, ${s.warn} warn, ${s.info} info`;
  } else {
    summary = `HYGIENE_EXIT_${exitCode}`;
  }

  return { exitCode, report, summary };
}
