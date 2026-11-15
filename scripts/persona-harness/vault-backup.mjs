/**
 * Back up (and restore) the DEPLOYED plugin before a persona run touches it.
 *
 * Persona runs deploy a fresh build and change plugin settings in the live vault.
 * This copies the deployed plugin's main.js, manifest.json, styles.css and data.json
 * into a timestamped folder under this harness's own gitignored `sessions/backups/`,
 * so a bad run can be undone.
 *
 * Targets come from the same place the build's auto-deploy reads them:
 *   deploy.local.json ({ "targets": [...] }, repo root or the main checkout), else
 *   AIORG_DEPLOY_TARGETS (`;`-separated). No target = a no-op with a message.
 *
 * CLI:
 *   node scripts/persona-harness/vault-backup.mjs backup
 *   node scripts/persona-harness/vault-backup.mjs restore [backup-dir]   (default: newest)
 *   node scripts/persona-harness/vault-backup.mjs list
 */

import {
    copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BACKUP_ROOT = join(HERE, 'sessions', 'backups');
export const BACKUP_FILES = ['main.js', 'manifest.json', 'styles.css', 'data.json'];

/** Read targets from a deploy.local.json path, or null when absent or unusable. */
function targetsFromFile(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.targets)) return parsed.targets.map(s => String(s).trim()).filter(Boolean);
    } catch { /* absent or unreadable */ }
    return null;
}

/** The main checkout's root (linked worktrees do not carry the gitignored deploy.local.json). */
function mainCheckoutRoot(repoRoot) {
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return common ? dirname(common) : null;
    } catch {
        return null;
    }
}

/** Resolve the deploy targets; same precedence as esbuild.config.mjs. */
export function resolveTargets({ repoRoot = resolve(HERE, '..', '..'), env = process.env } = {}) {
    for (const root of [repoRoot, mainCheckoutRoot(repoRoot)]) {
        if (!root) continue;
        const t = targetsFromFile(join(root, 'deploy.local.json'));
        if (t) return t;
    }
    if (env.AIORG_DEPLOY_TARGETS) {
        return env.AIORG_DEPLOY_TARGETS.split(';').map(s => s.trim()).filter(Boolean);
    }
    return [];
}

/** Filesystem-safe UTC timestamp, e.g. 2026-11-15T18-55-11Z. */
export function stamp(now = new Date()) {
    return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Copy each target's plugin files into `<backupRoot>/<stamp>/<n>/` and record the
 * source in `meta.json`. Targets that do not exist are skipped. Returns the backup
 * dir, or null when nothing was backed up.
 */
export function backupTargets(targets, { backupRoot = BACKUP_ROOT, now = new Date(), log = console.log } = {}) {
    if (!targets || targets.length === 0) {
        log('[vault-backup] no deploy target configured (deploy.local.json / AIORG_DEPLOY_TARGETS) - nothing to back up.');
        return null;
    }
    const dir = join(backupRoot, stamp(now));
    const entries = [];
    targets.forEach((target) => {
        if (!existsSync(target)) {
            log(`[vault-backup] target not found, skipped: ${target}`);
            return;
        }
        const sub = String(entries.length);
        const dest = join(dir, sub);
        mkdirSync(dest, { recursive: true });
        const files = [];
        for (const f of BACKUP_FILES) {
            const src = join(target, f);
            if (!existsSync(src)) continue;
            copyFileSync(src, join(dest, f));
            files.push(f);
        }
        entries.push({ sub, target, files });
    });
    if (entries.length === 0) return null;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ createdAt: now.toISOString(), entries }, null, 2));
    log(`[vault-backup] backed up ${entries.length} target(s) -> ${dir}`);
    return dir;
}

/** Newest backup dir under `backupRoot`, or null. Stamps sort chronologically. */
export function latestBackup(backupRoot = BACKUP_ROOT) {
    if (!existsSync(backupRoot)) return null;
    const names = readdirSync(backupRoot)
        .filter(n => existsSync(join(backupRoot, n, 'meta.json')))
        .sort();
    return names.length ? join(backupRoot, names[names.length - 1]) : null;
}

/** Copy a backup's files back over the recorded targets. Returns the targets restored. */
export function restoreBackup(backupDir, { log = console.log } = {}) {
    if (!backupDir || !existsSync(join(backupDir, 'meta.json'))) {
        throw new Error(`not a vault backup (no meta.json): ${backupDir}`);
    }
    const meta = JSON.parse(readFileSync(join(backupDir, 'meta.json'), 'utf8'));
    const restored = [];
    for (const { sub, target, files } of meta.entries) {
        mkdirSync(target, { recursive: true });
        for (const f of files) copyFileSync(join(backupDir, sub, f), join(target, f));
        log(`[vault-backup] restored ${files.length} file(s) -> ${target}`);
        restored.push(target);
    }
    return restored;
}

let backedUpThisProcess = false;

/**
 * Persona drivers call this before anything deploys or changes settings. Runs once per
 * process; AIORG_SKIP_VAULT_BACKUP=1 opts out. A failed backup throws, so the run stops.
 */
export function ensureVaultBackup(opts = {}) {
    if (backedUpThisProcess || process.env.AIORG_SKIP_VAULT_BACKUP === '1') return null;
    backedUpThisProcess = true;
    return backupTargets(resolveTargets(), opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'backup') {
        backupTargets(resolveTargets());
    } else if (cmd === 'restore') {
        const dir = arg ? resolve(arg) : latestBackup();
        if (!dir) { console.error('[vault-backup] no backup found.'); process.exit(1); }
        restoreBackup(dir);
    } else if (cmd === 'list') {
        if (existsSync(BACKUP_ROOT)) readdirSync(BACKUP_ROOT).sort().forEach(n => console.log(join(BACKUP_ROOT, n)));
    } else {
        console.error('usage: vault-backup.mjs backup | restore [backup-dir] | list');
        process.exit(1);
    }
}
