#!/usr/bin/env node
/**
 * Private staged-file guard.
 *
 * Fails a commit that stages a private artefact: anything under `.vault-private/`,
 * `docs/plans/`, `docs/completed/`, a generated agent-index file, or any file whose
 * content contains a marker string listed in the gitignored `.vault-private/guard.json`.
 *
 * Opt-in by installation: the hook installed by `scripts/install-private-hook.mjs`
 * sets `AIO_PRIVATE_GUARD=1`. With that flag the script fails closed (exit 2) when the
 * index is non-empty and the marker config is missing. Without it (contributors, CI,
 * a plain manual run) it prints one line and exits 0, so it is never a hurdle for
 * anyone who has not installed it.
 *
 * Reads the INDEX (`git diff --cached`), not the working tree, with no shell.
 * Marker values are never printed: a report names the path and the rule only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Path rules, as globs: `**` crosses folders, `*` does not. */
export const DEFAULT_PATH_RULES = Object.freeze([
	'.vault-private/**',
	'docs/plans/**',
	'docs/completed/**',
	'**/agent-index*.jsonl*',
	'agent-index*.jsonl*',
]);

/** Convert a rule glob to an anchored regular expression. */
export function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if ('\\^$+?.()|{}[]'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp('^' + re + '$');
}

/** Normalise a git path (always forward slashes, no leading ./). */
function normalisePath(p) {
	return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Pure check over staged entries.
 * @param {{status: string, path: string, oldPath?: string, blob?: string}[]} entries
 * @param {(entry: object) => (Buffer|string|null)} readBlob returns the staged content
 * @param {{pathRules?: string[], markers?: string[]}} rules
 * @returns {{ok: boolean, violations: {path: string, rule: string}[]}}
 */
export function checkStaged(entries, readBlob, rules = {}) {
	const pathRules = (rules.pathRules ?? DEFAULT_PATH_RULES).map((g) => ({ glob: g, re: globToRegExp(g) }));
	const markers = (rules.markers ?? []).filter((m) => typeof m === 'string' && m.length > 0).map((m) => m.toLowerCase());
	const violations = [];
	for (const entry of entries) {
		if (entry.status === 'D') continue; // removing a file from the index leaks nothing
		const path = normalisePath(entry.path);
		const candidates = [path];
		if (entry.oldPath) candidates.push(normalisePath(entry.oldPath));
		let blocked = false;
		for (const candidate of candidates) {
			const hit = pathRules.find((r) => r.re.test(candidate));
			if (hit) {
				violations.push({ path, rule: `path:${hit.glob}` });
				blocked = true;
				break;
			}
		}
		if (blocked || markers.length === 0) continue;
		const blob = readBlob(entry);
		if (blob == null) continue;
		const text = (typeof blob === 'string' ? blob : blob.toString('utf8')).toLowerCase();
		if (markers.some((m) => text.includes(m))) {
			violations.push({ path, rule: 'content-marker' });
		}
	}
	return { ok: violations.length === 0, violations };
}

/** Parse `git diff --cached --raw -z --no-abbrev -M` output. */
export function parseRawDiff(output) {
	const parts = output.split('\0');
	const entries = [];
	for (let i = 0; i < parts.length; i++) {
		const header = parts[i];
		if (!header.startsWith(':')) continue;
		const fields = header.slice(1).split(' ');
		const status = fields[4]?.[0] ?? '';
		const blob = fields[3];
		if (status === 'R' || status === 'C') {
			entries.push({ status, oldPath: parts[i + 1], path: parts[i + 2], blob });
			i += 2;
		} else {
			entries.push({ status, path: parts[i + 1], blob });
			i += 1;
		}
	}
	return entries;
}

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Read a blob by id with `git cat-file` (no shell). */
function readBlobById(blob, cwd) {
	const res = spawnSync('git', ['cat-file', 'blob', blob], { cwd, maxBuffer: 256 * 1024 * 1024 });
	return res.status === 0 ? res.stdout : null;
}

/** Load the marker configuration, or null when missing or unreadable. */
export function loadGuardConfig(cwd) {
	const file = join(cwd, '.vault-private', 'guard.json');
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		const markers = Array.isArray(parsed?.markers) ? parsed.markers.filter((m) => typeof m === 'string') : [];
		return { markers };
	} catch {
		return null;
	}
}

/** CLI entry. Returns the process exit code. */
export function run({ cwd = process.cwd(), env = process.env, log = console.log } = {}) {
	if (env.AIO_PRIVATE_GUARD !== '1') {
		log('private guard not installed (set AIO_PRIVATE_GUARD=1 or run scripts/install-private-hook.mjs); skipping');
		return 0;
	}
	let entries;
	try {
		entries = parseRawDiff(git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '-M'], cwd));
	} catch (e) {
		log(`private guard: could not read the index (${e instanceof Error ? e.message : 'unknown error'})`);
		return 2;
	}
	if (entries.length === 0) return 0;
	const config = loadGuardConfig(cwd);
	if (!config) {
		log('private guard: .vault-private/guard.json is missing or unreadable; refusing to commit (fail closed)');
		return 2;
	}
	const result = checkStaged(entries, (entry) => readBlobById(entry.blob, cwd), { markers: config.markers });
	if (result.ok) return 0;
	log('private guard: refusing to commit. Staged files that must stay private:');
	for (const v of result.violations) log(`  ${v.path} (${v.rule})`);
	log('Unstage them with: git restore --staged <path>');
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(run());
}
