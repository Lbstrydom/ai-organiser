#!/usr/bin/env node
/**
 * Installs the private staged-file guard as a git pre-commit hook.
 *
 * - Resolves the hooks directory with `git rev-parse --git-path hooks`, so it respects
 *   `core.hooksPath` and linked worktrees.
 * - Refuses to overwrite a pre-commit hook it did not write.
 * - Idempotent: running it again rewrites its own hook with the current script path.
 *
 * The hook only sets `AIO_PRIVATE_GUARD=1` and runs `scripts/check-private-staged.mjs`;
 * contributors who never run this installer are not affected.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOOK_MARKER = '# aio-private-guard (managed by scripts/install-private-hook.mjs)';

/** Build the hook text. Paths are absolute, forward-slashed and double-quoted. */
export function buildHookScript(guardScriptPath) {
	const quoted = guardScriptPath.replaceAll('\\', '/').replaceAll('"', '\\"');
	return `#!/bin/sh\n${HOOK_MARKER}\nAIO_PRIVATE_GUARD=1 node "${quoted}" || exit $?\n`;
}

/**
 * Decide what to do given the existing hook text (or null when absent).
 * @returns {{action: 'create'|'update'|'refuse', reason?: string}}
 */
export function planInstall(existing) {
	if (existing == null) return { action: 'create' };
	if (existing.includes(HOOK_MARKER)) return { action: 'update' };
	return { action: 'refuse', reason: 'a pre-commit hook that this installer did not write already exists' };
}

/** Resolve the hooks directory for the repo at `cwd`. */
export function resolveHooksDir(cwd) {
	const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8' }).trim();
	return isAbsolute(out) ? out : resolve(cwd, out);
}

/** Install the hook. Returns `{ ok, message }`. */
export function installHook({ cwd = process.cwd(), guardScriptPath } = {}) {
	const script = guardScriptPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'check-private-staged.mjs');
	const hooksDir = resolveHooksDir(cwd);
	const hookFile = join(hooksDir, 'pre-commit');
	const existing = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : null;
	const plan = planInstall(existing);
	if (plan.action === 'refuse') {
		return { ok: false, message: `Not installed: ${plan.reason} (${hookFile}). Add the guard to it by hand, or remove it and run this again.` };
	}
	mkdirSync(hooksDir, { recursive: true });
	writeFileSync(hookFile, buildHookScript(script), { encoding: 'utf8' });
	try {
		chmodSync(hookFile, 0o755);
	} catch {
		// Windows filesystems ignore the mode bit; git for Windows runs the hook anyway.
	}
	return { ok: true, message: `${plan.action === 'create' ? 'Installed' : 'Updated'} the private guard at ${hookFile}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = installHook();
	console.log(result.message);
	process.exit(result.ok ? 0 : 1);
}
