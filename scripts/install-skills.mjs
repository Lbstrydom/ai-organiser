#!/usr/bin/env node
/**
 * @fileoverview Install engineering skills to consumer repos.
 * Thin CLI wrapper composing lib/install/ modules.
 *
 * Usage:
 *   node scripts/install-skills.mjs --local --surface both
 *   node scripts/install-skills.mjs --remote --surface copilot
 *   node scripts/install-skills.mjs --dry-run --surface both
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ManifestSchema } from './lib/schemas-install.mjs';
import { findRepoRoot, resolveSkillTargets, receiptPath } from './lib/install/surface-paths.mjs';
import { readReceipt, writeReceipt, buildReceipt } from './lib/install/receipt.mjs';
import { detectConflicts, computeFileSha } from './lib/install/conflict-detector.mjs';
import { mergeBlock, COPILOT_BLOCK } from './lib/install/merge.mjs';
import { executeTransaction } from './lib/install/transaction.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function parseArgs(argv) {
  const args = {
    local: false,
    remote: false,
    surface: 'both',
    skills: null,
    force: false,
    dryRun: false,
    repoRoot: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--local': args.local = true; break;
      case '--remote': args.remote = true; break;
      case '--surface': args.surface = argv[++i]; break;
      case '--skills': args.skills = argv[++i]?.split(','); break;
      case '--force': args.force = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--repo-root': args.repoRoot = argv[++i]; break;
    }
  }
  // Default: local if skills/ exists, remote otherwise
  if (!args.local && !args.remote) {
    args.local = fs.existsSync(path.resolve('skills'));
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.repoRoot || findRepoRoot();

  console.log(`${B}Engineering Skills Installer${X}`);
  console.log(`  Mode: ${args.local ? 'local' : 'remote'}`);
  console.log(`  Surface: ${args.surface}`);
  console.log(`  Repo root: ${repoRoot}`);
  if (args.dryRun) console.log(`  ${Y}DRY RUN — no files will be written${X}`);
  console.log('');

  // Load manifest
  let manifest;
  if (args.local) {
    const manifestPath = path.resolve('skills.manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error(`${R}Error${X}: skills.manifest.json not found. Run: node scripts/build-manifest.mjs`);
      process.exit(1);
    }
    manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  } else {
    console.error(`${R}Error${X}: --remote mode not implemented yet (Phase F follow-up)`);
    process.exit(1);
  }

  // Filter skills
  const skillNames = args.skills || Object.keys(manifest.skills);
  const availableSkills = skillNames.filter(s => manifest.skills[s]);
  if (availableSkills.length === 0) {
    console.error(`${R}Error${X}: no matching skills in manifest`);
    process.exit(1);
  }

  console.log(`  Skills: ${availableSkills.join(', ')}`);

  // Prepare writes
  const writes = [];
  const managedFiles = [];

  for (const skillName of availableSkills) {
    const meta = manifest.skills[skillName];
    const sourcePath = path.resolve(meta.path);
    if (!fs.existsSync(sourcePath)) {
      console.error(`${R}Error${X}: source file missing: ${meta.path}`);
      process.exit(1);
    }
    const content = fs.readFileSync(sourcePath);
    const sha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

    // Verify SHA matches manifest
    if (sha !== meta.sha) {
      console.error(`${R}Error${X}: SHA mismatch for ${skillName} (manifest: ${meta.sha}, actual: ${sha}). Run: node scripts/build-manifest.mjs`);
      process.exit(1);
    }

    const targets = resolveSkillTargets(skillName, args.surface, repoRoot);
    for (const target of targets) {
      writes.push({
        path: path.relative(repoRoot, target.filePath).replace(/\\/g, '/'),
        absPath: target.filePath,
        content,
        sha,
      });
      managedFiles.push({
        path: path.relative(repoRoot, target.filePath).replace(/\\/g, '/'),
        sha,
        skill: skillName,
      });
    }
  }

  // Add copilot-instructions merge (for copilot or both surface)
  if (args.surface === 'copilot' || args.surface === 'both') {
    const copilotPath = path.join(repoRoot, '.github', 'copilot-instructions.md');
    const existing = fs.existsSync(copilotPath)
      ? fs.readFileSync(copilotPath, 'utf-8')
      : null;
    const merged = mergeBlock(existing);
    const blockSha = crypto.createHash('sha256')
      .update(COPILOT_BLOCK).digest('hex').slice(0, 12);

    writes.push({
      path: '.github/copilot-instructions.md',
      absPath: copilotPath,
      content: Buffer.from(merged, 'utf-8'),
      sha: blockSha,
    });
    managedFiles.push({
      path: '.github/copilot-instructions.md',
      sha: blockSha, // Actually blockSha but keep consistent
      blockSha,
      merged: true,
    });
  }

  // Read existing receipt
  const repoReceiptPath = receiptPath('repo', repoRoot);
  const { receipt: existingReceipt } = readReceipt(repoReceiptPath);

  // Detect conflicts
  const { safe, conflicts } = detectConflicts(writes, existingReceipt, { force: args.force });

  if (conflicts.length > 0) {
    console.log(`\n${R}Conflicts detected:${X}`);
    for (const c of conflicts) {
      console.log(`  ${R}x${X} ${c.path}: ${c.reason}`);
    }
    if (!args.force) {
      console.log(`\nUse --force to overwrite, or resolve conflicts first.`);
      process.exit(1);
    }
  }

  if (args.dryRun) {
    console.log(`\n${Y}Would write ${safe.length} files:${X}`);
    for (const w of safe) {
      console.log(`  ${w.path}`);
    }
    process.exit(0);
  }

  // Execute transaction
  const result = executeTransaction(safe.map(w => ({ absPath: w.absPath, content: w.content })));

  if (!result.success) {
    console.error(`${R}Install failed${X}: ${result.error}`);
    console.error('All changes have been rolled back.');
    process.exit(1);
  }

  // Write receipt
  const receipt = buildReceipt({
    bundleVersion: manifest.bundleVersion,
    sourceUrl: manifest.rawUrlBase,
    surface: args.surface,
    managedFiles,
  });
  writeReceipt(repoReceiptPath, receipt);

  console.log(`\n${G}Installed ${result.written} files${X}`);
  console.log(`  Bundle version: ${manifest.bundleVersion}`);
  console.log(`  Receipt: ${path.relative(repoRoot, repoReceiptPath)}`);
  for (const w of safe) {
    console.log(`  ${G}+${X} ${w.path}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`${R}Install error${X}: ${err.message}`);
  process.exit(1);
}
