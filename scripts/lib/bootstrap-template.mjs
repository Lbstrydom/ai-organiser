#!/usr/bin/env node
/**
 * @fileoverview Bootstrap entry point for consumer repos.
 * Fetches heavier scripts from upstream, caches them 24hr, executes.
 * ~80 LoC, zero dependencies beyond Node built-ins.
 *
 * This file serves as the SOURCE TEMPLATE. The installer copies it to
 * consumer repos at .audit-loop/bootstrap.mjs.
 *
 * Sub-commands: install, check, version, help
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAW_BASE = 'https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main';
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24hr

const COMMANDS = {
  install: 'scripts/install-skills.mjs',
  check: 'scripts/check-skill-updates.mjs',
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-engineering-skills-bootstrap' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getCached(scriptName) {
  const cached = path.join(CACHE_DIR, scriptName);
  if (!fs.existsSync(cached)) return null;
  const stat = fs.statSync(cached);
  if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
  return cached;
}

async function fetchAndCache(scriptName) {
  const url = `${RAW_BASE}/${scriptName}`;
  const content = await fetch(url);
  const cached = path.join(CACHE_DIR, scriptName.replace(/\//g, '_'));
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, content);
  return cached;
}

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`Usage: node .audit-loop/bootstrap.mjs <command> [options]

Commands:
  install   Install/update skills (--surface both|claude|copilot|agents)
  check     Check for updates + local drift
  version   Show installed bundle version
  help      Show this message`);
    return;
  }

  if (cmd === 'version') {
    const receiptPath = path.resolve('.audit-loop-install-receipt.json');
    if (fs.existsSync(receiptPath)) {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
      console.log(`Bundle version: ${receipt.bundleVersion}`);
      console.log(`Installed: ${receipt.installedAt}`);
    } else {
      console.log('No install detected.');
    }
    return;
  }

  const scriptName = COMMANDS[cmd];
  if (!scriptName) {
    console.error(`Unknown command: ${cmd}. Use 'help' for usage.`);
    process.exit(1);
  }

  // Try cache first
  let scriptPath = getCached(scriptName.replace(/\//g, '_'));
  if (!scriptPath) {
    try {
      process.stderr.write('Fetching latest scripts...\n');
      scriptPath = await fetchAndCache(scriptName);
    } catch (err) {
      console.error(`Failed to fetch ${scriptName}: ${err.message}`);
      process.exit(1);
    }
  }

  // Spawn with passthrough args (execFileSync prevents command injection)
  try {
    execFileSync(process.execPath, [scriptPath, '--remote', ...rest], { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
