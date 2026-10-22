/**
 * Release-version guard.
 *
 * Releases are batched and only the owner decides (AGENTS.md, "Releasing"): Obsidian offers users an
 * update when a GitHub release carries a higher manifest.json version, so a stray version bump in an
 * ordinary PR is how users end up updated every few minutes. This script fails a pull request that
 * changes the release version in manifest.json, versions.json, package.json or package-lock.json
 * unless the PR carries the `release` label (a maintainer-only action on a public repository, so an
 * outside contributor cannot exempt their own PR).
 *
 * Pure decision functions are exported for tests; `main` does the git I/O.
 *
 * Usage: node scripts/check-version-bump.mjs --base <sha> --head <sha> [--labels "a,b"]
 *   Labels may also come from the PR_LABELS environment variable (preferred in CI: label names are
 *   user-controlled text and must never be interpolated into a shell command).
 * Exit: 0 ok, 1 a guarded version changed without the release label, 2 bad arguments or a git failure
 *   (fail closed: if the comparison cannot be made, the check does not pass).
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RELEASE_LABEL = 'release';
export const GUARDED_FILES = Object.freeze(['manifest.json', 'versions.json', 'package.json', 'package-lock.json']);

/** What counts as "the version" of each guarded file, as a comparable string; null when absent. */
export function versionFingerprint(file, text) {
	if (text === null || text === undefined) return null;
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return '<unparseable>';
	}
	if (json === null || typeof json !== 'object') return '<unparseable>';
	if (file === 'versions.json') {
		// A version -> minAppVersion history map: any added, removed or changed entry is a version change.
		const sorted = Object.keys(json).sort().map((k) => [k, json[k]]);
		return JSON.stringify(sorted);
	}
	if (file === 'package-lock.json') {
		const root = json.packages && json.packages[''] ? json.packages[''].version : undefined;
		return JSON.stringify({ version: json.version, root });
	}
	return JSON.stringify({ version: json.version });
}

/** Compare file texts at the base and at the head; returns the guarded files whose version changed. */
export function findVersionChanges(baseTexts, headTexts) {
	const changes = [];
	for (const file of GUARDED_FILES) {
		const from = versionFingerprint(file, baseTexts[file]);
		const to = versionFingerprint(file, headTexts[file]);
		if (from !== to) changes.push({ file, from, to });
	}
	return changes;
}

export function hasReleaseLabel(labels) {
	return labels.some((l) => l.trim().toLowerCase() === RELEASE_LABEL);
}

export function parseLabels(raw) {
	return (raw ?? '')
		.split(',')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** The verdict for a pull request: ok when nothing guarded changed, or the release label is present. */
export function evaluate({ changes, labels }) {
	if (changes.length === 0) return { ok: true, reason: 'no release version changed' };
	if (hasReleaseLabel(labels)) {
		return { ok: true, reason: `release PR (label "${RELEASE_LABEL}"): ${changes.map((c) => c.file).join(', ')} may change` };
	}
	const files = changes.map((c) => c.file).join(', ');
	return {
		ok: false,
		reason:
			`This PR changes the release version in: ${files}.\n` +
			'Releases are batched and only the owner decides (AGENTS.md, "Releasing"), so an ordinary PR must not bump the version.\n' +
			`If this is a release PR, a maintainer must add the "${RELEASE_LABEL}" label; otherwise revert the version change.`,
	};
}

function git(args, cwd) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** File text at a ref, or null when the file does not exist there. Any other git failure throws. */
export function readFileAtRef(ref, file, cwd) {
	try {
		return git(['show', `${ref}:${file}`], cwd);
	} catch (e) {
		const stderr = String(e && e.stderr ? e.stderr : '');
		if (/exists on disk, but not in|does not exist in|path .* does not exist/i.test(stderr)) return null;
		throw e;
	}
}

export function parseArgs(argv) {
	const out = { base: '', head: '', labels: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--base') out.base = argv[++i] ?? '';
		else if (a === '--head') out.head = argv[++i] ?? '';
		else if (a === '--labels') out.labels = argv[++i] ?? '';
		else throw new Error(`unknown argument: ${a}`);
	}
	if (!out.base || !out.head) throw new Error('--base and --head are required');
	return out;
}

export function main(argv, env = process.env, cwd = process.cwd()) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (e) {
		console.error(`check-version-bump: ${e.message}`);
		return 2;
	}
	const labels = parseLabels(args.labels !== undefined ? args.labels : env.PR_LABELS);
	let baseTexts = {};
	let headTexts = {};
	try {
		// Compare against the merge base so changes that landed on the base branch after this PR branched are not blamed on it.
		const mergeBase = git(['merge-base', args.base, args.head], cwd).trim();
		for (const file of GUARDED_FILES) {
			baseTexts[file] = readFileAtRef(mergeBase, file, cwd);
			headTexts[file] = readFileAtRef(args.head, file, cwd);
		}
	} catch (e) {
		console.error(`check-version-bump: could not compare ${args.base} and ${args.head}: ${e.message}`);
		return 2;
	}
	const verdict = evaluate({ changes: findVersionChanges(baseTexts, headTexts), labels });
	if (verdict.ok) {
		console.log(`check-version-bump: OK (${verdict.reason})`);
		return 0;
	}
	console.error(`check-version-bump: FAIL\n${verdict.reason}`);
	return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exit(main(process.argv.slice(2)));
}
