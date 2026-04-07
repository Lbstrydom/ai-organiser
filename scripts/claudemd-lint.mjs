#!/usr/bin/env node
/**
 * @fileoverview CLAUDE.md hygiene linter CLI.
 * Checks instruction files for sprawl, stale references, duplication, and size violations.
 *
 * Usage:
 *   node scripts/claudemd-lint.mjs [--format terminal|json|sarif] [--out <file>]
 *   node scripts/claudemd-lint.mjs --fix [--yes]
 *   node scripts/claudemd-lint.mjs --config .claudemd-lint.json
 *
 * Exit codes:
 *   0: all rules pass (or only INFO findings)
 *   1: at least one ERROR finding
 *   2: at least one WARN finding (no ERRORs)
 *   3: linter itself failed (bad config, scan error)
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanInstructionFiles } from './lib/claudemd/file-scanner.mjs';
import { runRules, DEFAULT_RULES } from './lib/claudemd/rules.mjs';
import { toSarif } from './lib/claudemd/sarif-formatter.mjs';
import { applyFixes } from './lib/claudemd/autofix.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function parseArgs(argv) {
  const args = {
    format: 'terminal',
    out: null,
    config: null,
    fix: false,
    yes: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--format': args.format = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--config': args.config = argv[++i]; break;
      case '--fix': args.fix = true; break;
      case '--yes': args.yes = true; break;
    }
  }

  return args;
}

function loadConfig(configPath) {
  if (!configPath) {
    // Try default location
    const defaultPath = path.resolve('.claudemd-lint.json');
    if (fs.existsSync(defaultPath)) {
      try {
        return JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
      } catch { /* use defaults */ }
    }
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`${R}Error${X}: failed to read config: ${err.message}\n`);
    process.exit(3);
  }
}

function main() {
  const args = parseArgs(process.argv);

  // Validate format + out combination
  if ((args.format === 'json' || args.format === 'sarif') && !args.out) {
    process.stderr.write(`${R}Error${X}: --out is required with --format ${args.format}\n`);
    process.exit(3);
  }

  const repoRoot = process.cwd();
  const config = loadConfig(args.config);
  const ruleConfig = config.rules || {};
  const ignoreGlobs = config.ignore || [];

  // Scan instruction files
  const { files } = scanInstructionFiles(repoRoot, { additionalExcludes: ignoreGlobs });

  if (files.length === 0) {
    process.stderr.write(`${D}No instruction files found${X}\n`);
    console.log('claudemd-lint: 0 files, 0 findings');
    process.exit(0);
  }

  // Run rules
  const findings = runRules(files, repoRoot, ruleConfig);

  // Sort by severity (error first, then warn, then info)
  const severityOrder = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  // Build report
  const report = {
    version: '1',
    timestamp: new Date().toISOString(),
    files_scanned: files.map(f => f.path),
    findings,
    summary: {
      error: findings.filter(f => f.severity === 'error').length,
      warn: findings.filter(f => f.severity === 'warn').length,
      info: findings.filter(f => f.severity === 'info').length,
    },
  };

  // Auto-fix mode
  if (args.fix) {
    const fixable = findings.filter(f => f.fixable);
    if (fixable.length === 0) {
      process.stderr.write(`${D}No fixable findings${X}\n`);
    } else {
      // Dry run first
      const preview = applyFixes(findings, repoRoot, { dryRun: true });
      if (preview.applied.length > 0) {
        process.stderr.write(`\nFixable findings (${preview.applied.length}):\n`);
        for (const a of preview.applied) {
          process.stderr.write(`  ${a.file}:${a.line} — ${a.action}\n`);
        }
        if (preview.skipped.length > 0) {
          process.stderr.write(`Skipped (${preview.skipped.length}):\n`);
          for (const s of preview.skipped) {
            process.stderr.write(`  ${s.file}:${s.line} — ${s.reason}\n`);
          }
        }

        if (args.yes) {
          applyFixes(findings, repoRoot, { dryRun: false });
          process.stderr.write(`${G}Applied ${preview.applied.length} fixes${X}\n`);
        } else {
          process.stderr.write(`\nRun with --fix --yes to apply.\n`);
        }
      }
    }
  }

  // Output
  if (args.format === 'terminal') {
    // Terminal output to stderr
    if (findings.length > 0) {
      process.stderr.write('\n');
      let currentFile = null;
      for (const f of findings) {
        if (f.file !== currentFile) {
          currentFile = f.file;
          process.stderr.write(`\n  ${f.file}\n`);
        }
        const sev = f.severity === 'error' ? `${R}ERROR${X}` : f.severity === 'warn' ? `${Y}WARN${X}` : `${D}INFO${X}`;
        const loc = f.line ? `:${f.line}` : '';
        process.stderr.write(`    ${sev} [${f.ruleId}]${loc} ${f.message}\n`);
      }
      process.stderr.write('\n');
    }
  } else if (args.format === 'json') {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
  } else if (args.format === 'sarif') {
    fs.writeFileSync(args.out, JSON.stringify(toSarif(report), null, 2) + '\n');
  }

  // Summary to stdout
  const s = report.summary;
  console.log(`claudemd-lint: ${files.length} files, ${findings.length} findings (${s.error} error, ${s.warn} warn, ${s.info} info)`);

  // Exit code
  if (s.error > 0) process.exit(1);
  if (s.warn > 0) process.exit(2);
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${R}Linter error${X}: ${err.message}\n`);
  process.exit(3);
}
