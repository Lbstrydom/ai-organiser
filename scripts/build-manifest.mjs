#!/usr/bin/env node
/**
 * @fileoverview Compute SHAs + bundleVersion, update skills.manifest.json.
 *
 * Usage:
 *   node scripts/build-manifest.mjs           # rebuild manifest
 *   node scripts/build-manifest.mjs --check    # verify manifest is fresh (CI guard)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ManifestSchema } from './lib/schemas-install.mjs';

const SKILLS_DIR = path.resolve('skills');
const MANIFEST_PATH = path.resolve('skills.manifest.json');
const BOOTSTRAP_TEMPLATE = path.resolve('scripts/lib/bootstrap-template.mjs');
const COPILOT_BLOCK_TEMPLATE = path.resolve('scripts/lib/install/copilot-block.txt');
const MANIFEST_SCHEMA_VERSION = 1;

const REPO_URL = 'https://github.com/Lbstrydom/claude-engineering-skills';
const RAW_URL_BASE = 'https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main';

/**
 * Compute SHA-256 hex of file content.
 * @param {string} filePath
 * @returns {string} first 12 hex chars
 */
function fileSha(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Build the skills manifest from the skills/ directory.
 * @returns {object} Validated manifest object
 */
export function buildManifest() {
  const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const skills = {};
  const artifactParts = [];

  for (const name of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf-8');
    const sha = fileSha(skillPath);
    const size = Buffer.byteLength(content, 'utf-8');

    // Extract summary from frontmatter description (first line)
    const descMatch = content.match(/description:\s*\|?\s*\n\s+(.+)/);
    const summary = descMatch ? descMatch[1].trim().slice(0, 100) : name;

    skills[name] = {
      path: `skills/${name}/SKILL.md`,
      sha,
      size,
      summary,
    };

    artifactParts.push(`skill:${name}:${sha}`);
  }

  // Include bootstrap template + copilot block in version hash if they exist
  if (fs.existsSync(BOOTSTRAP_TEMPLATE)) {
    artifactParts.push(`bootstrap:${fileSha(BOOTSTRAP_TEMPLATE)}`);
  }
  if (fs.existsSync(COPILOT_BLOCK_TEMPLATE)) {
    artifactParts.push(`copilot-block:${fileSha(COPILOT_BLOCK_TEMPLATE)}`);
  }
  artifactParts.push(`manifest-schema:${MANIFEST_SCHEMA_VERSION}`);

  // Deterministic bundleVersion: sort pairs, hash concatenation
  const pairs = artifactParts.sort().join('\n');
  const bundleVersion = crypto.createHash('sha256').update(pairs).digest('hex').slice(0, 16);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bundleVersion,
    repoUrl: REPO_URL,
    rawUrlBase: RAW_URL_BASE,
    updatedAt: new Date().toISOString(),
    skills,
  };

  // Validate
  ManifestSchema.parse(manifest);
  return manifest;
}

function main() {
  const checkMode = process.argv.includes('--check');

  const manifest = buildManifest();

  if (checkMode) {
    // Compare against committed manifest
    if (!fs.existsSync(MANIFEST_PATH)) {
      console.error('FAIL: skills.manifest.json does not exist. Run: node scripts/build-manifest.mjs');
      process.exit(1);
    }
    const existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

    // Compare bundleVersion (content-deterministic)
    if (existing.bundleVersion === manifest.bundleVersion) {
      console.log(`OK: manifest is fresh (${manifest.bundleVersion})`);
      process.exit(0);
    } else {
      console.error(`STALE: manifest bundleVersion mismatch`);
      console.error(`  committed: ${existing.bundleVersion}`);
      console.error(`  computed:  ${manifest.bundleVersion}`);
      console.error(`Run: node scripts/build-manifest.mjs`);
      process.exit(1);
    }
  }

  // Write manifest (exclude updatedAt from comparison — it's informational)
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`skills.manifest.json updated: ${Object.keys(manifest.skills).length} skills, version ${manifest.bundleVersion}`);
}

main();
