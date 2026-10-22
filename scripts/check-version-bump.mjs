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
 * TRUST: in CI this file runs from the BASE branch (the workflow uses pull_request_target and never
 * checks out the PR head), and the PR's files are only ever read as git data through `git show`. A PR
 * can therefore not replace the validator that judges it.
 *
 * Pure decision functions are exported for tests; `main` does the git I/O.
 *
 * Usage: node scripts/check-version-bump.mjs --base <sha> --head <sha> [--labels "a,b"]
 *   Labels come from --labels (a human-friendly comma list, for local use) or, in CI, from the
 *   PR_LABELS_JSON environment variable: a JSON array of label names, because a label name may itself
 *   contain a comma and a delimiter-joined string would change which labels the PR appears to carry.
 * Exit: 0 ok, 1 a guarded version changed without the release label, 2 bad arguments, malformed
 *   input or a git failure (fail closed: if the comparison cannot be made, the check does not pass).
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RELEASE_LABEL = 'release';
export const GUARDED_FILES = Object.freeze(['manifest.json', 'versions.json', 'package.json', 'package-lock.json']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * What counts as "the version" of each guarded file, as an explicit outcome:
 *   { state: 'absent' }                  the file does not exist at that revision
 *   { state: 'ok', value }               a comparable string
 *   { state: 'invalid', reason }         malformed or not the expected shape: never comparable
 */
export function fingerprint(file, text) {
	if (text === null || text === undefined) return { state: 'absent' };
	let json;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return { state: 'invalid', reason: `not valid JSON (${e.message})` };
	}
	if (!isPlainObject(json)) return { state: 'invalid', reason: 'not a JSON object' };

	if (file === 'versions.json') {
		// A version -> minAppVersion history map: any added, removed or changed entry is a version change.
		const entries = Object.keys(json).sort().map((k) => [k, json[k]]);
		if (!entries.every(([, v]) => typeof v === 'string')) return { state: 'invalid', reason: 'a value is not a string' };
		return { state: 'ok', value: JSON.stringify(entries) };
	}
	if (!nonEmptyString(json.version)) return { state: 'invalid', reason: 'missing or non-string "version"' };
	if (file === 'package-lock.json') {
		const rootPkg = isPlainObject(json.packages) ? json.packages[''] : undefined;
		if (rootPkg !== undefined && !isPlainObject(rootPkg)) return { state: 'invalid', reason: 'packages[""] is not an object' };
		if (rootPkg && rootPkg.version !== undefined && typeof rootPkg.version !== 'string') {
			return { state: 'invalid', reason: 'packages[""].version is not a string' };
		}
		return { state: 'ok', value: JSON.stringify({ version: json.version, root: rootPkg ? rootPkg.version : undefined }) };
	}
	return { state: 'ok', value: JSON.stringify({ version: json.version }) };
}

/**
 * Compare file texts at the base and at the head. Returns the guarded files whose version changed and,
 * separately, any file that could not be compared at all (never folded into "unchanged").
 */
export function findVersionChanges(baseTexts, headTexts) {
	const changes = [];
	const invalid = [];
	for (const file of GUARDED_FILES) {
		const from = fingerprint(file, baseTexts[file]);
		const to = fingerprint(file, headTexts[file]);
		if (from.state === 'invalid') invalid.push({ file, side: 'base', reason: from.reason });
		if (to.state === 'invalid') invalid.push({ file, side: 'head', reason: to.reason });
		if (from.state === 'invalid' || to.state === 'invalid') continue;
		const a = from.state === 'ok' ? from.value : null;
		const b = to.state === 'ok' ? to.value : null;
		if (a !== b) changes.push({ file, from: a, to: b });
	}
	return { changes, invalid };
}

export function hasReleaseLabel(labels) {
	return labels.some((l) => l.trim().toLowerCase() === RELEASE_LABEL);
}

/** Human-friendly comma list for local use. Do not use it for CI: see parseLabelsJson. */
export function parseLabels(raw) {
	return (raw ?? '')
		.split(',')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** CI transport: a JSON array of strings. Anything else is rejected, never guessed at. */
export function parseLabelsJson(raw) {
	if (raw === undefined || raw === null || raw === '') return { ok: true, labels: [] };
	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, reason: 'PR_LABELS_JSON is not valid JSON' };
	}
	if (!Array.isArray(json) || !json.every((l) => typeof l === 'string')) {
		return { ok: false, reason: 'PR_LABELS_JSON must be a JSON array of strings' };
	}
	return { ok: true, labels: json };
}

/**
 * The verdict for a pull request. A file that could not be compared fails regardless of the label:
 * the release exemption only ever applies to a comparison that was actually made.
 */
export function evaluate({ changes, invalid = [], labels }) {
	if (invalid.length > 0) {
		const list = invalid.map((i) => `${i.file} at the ${i.side}: ${i.reason}`).join('; ');
		return { ok: false, invalidInput: true, reason: `Cannot compare the release version, so the check fails closed: ${list}.` };
	}
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

const defaultIo = {
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
};

export function main(argv, env = process.env, cwd = process.cwd(), io = defaultIo) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (e) {
		io.err(`check-version-bump: ${e.message}`);
		return 2;
	}
	let labels;
	if (args.labels !== undefined) {
		labels = parseLabels(args.labels);
	} else {
		const parsed = parseLabelsJson(env.PR_LABELS_JSON);
		if (!parsed.ok) {
			io.err(`check-version-bump: ${parsed.reason}`);
			return 2;
		}
		labels = parsed.labels;
	}
	const baseTexts = {};
	const headTexts = {};
	try {
		// Compare against the merge base so changes that landed on the base branch after this PR branched are not blamed on it.
		const mergeBase = git(['merge-base', args.base, args.head], cwd).trim();
		for (const file of GUARDED_FILES) {
			baseTexts[file] = readFileAtRef(mergeBase, file, cwd);
			headTexts[file] = readFileAtRef(args.head, file, cwd);
		}
	} catch (e) {
		io.err(`check-version-bump: could not compare ${args.base} and ${args.head}: ${e.message}`);
		return 2;
	}
	const verdict = evaluate({ ...findVersionChanges(baseTexts, headTexts), labels });
	if (verdict.ok) {
		io.out(`check-version-bump: OK (${verdict.reason})`);
		return 0;
	}
	io.err(`check-version-bump: FAIL\n${verdict.reason}`);
	return verdict.invalidInput ? 2 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exit(main(process.argv.slice(2)));
}
