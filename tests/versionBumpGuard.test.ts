import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import {
	RELEASE_LABEL,
	fingerprint,
	findVersionChanges,
	hasReleaseLabel,
	parseLabels,
	parseLabelsJson,
	evaluate,
	parseArgs,
	main,
} from '../scripts/check-version-bump.mjs';

const manifest = (version: string) => JSON.stringify({ id: 'x', version, minAppVersion: '1.11.4' });
const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'x', version, ...extra });
const versions = (map: Record<string, string>) => JSON.stringify(map);
const lock = (version: string) => JSON.stringify({ name: 'x', version, packages: { '': { name: 'x', version } } });

const baseTexts = (): Record<string, string | null> => ({
	'manifest.json': manifest('1.0.30'),
	'package.json': pkg('1.0.30'),
	'versions.json': versions({ '1.0.30': '1.11.4' }),
	'package-lock.json': lock('1.0.30'),
});

const verdictFor = (head: Record<string, string | null>, labels: string[], base = baseTexts()) =>
	evaluate({ ...findVersionChanges(base, head), labels });

// These tests spawn git and node child processes; under full-suite load the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000 });

describe('fingerprint: explicit outcomes, never a comparable stand-in for a failure', () => {
	it('reports an absent file as absent', () => {
		expect(fingerprint('manifest.json', null)).toEqual({ state: 'absent' });
		expect(fingerprint('manifest.json', undefined)).toEqual({ state: 'absent' });
	});

	it.each([
		['not JSON', '{ not json'],
		['JSON null', 'null'],
		['a JSON array', '[]'],
		['a number', '42'],
	])('flags %s as invalid', (_name, text) => {
		expect(fingerprint('manifest.json', text).state).toBe('invalid');
		expect(fingerprint('versions.json', text).state).toBe('invalid');
	});

	it('flags a manifest or package.json with no usable version as invalid', () => {
		expect(fingerprint('manifest.json', JSON.stringify({ id: 'x' })).state).toBe('invalid');
		expect(fingerprint('package.json', JSON.stringify({ version: 3 })).state).toBe('invalid');
		expect(fingerprint('package.json', JSON.stringify({ version: '' })).state).toBe('invalid');
	});

	it('flags a versions.json with a non-string value, and a lockfile whose root is the wrong shape', () => {
		expect(fingerprint('versions.json', JSON.stringify({ '1.0.0': 5 })).state).toBe('invalid');
		expect(fingerprint('package-lock.json', JSON.stringify({ version: '1', packages: { '': 'nope' } })).state).toBe('invalid');
		expect(fingerprint('package-lock.json', JSON.stringify({ version: '1', packages: { '': { version: 2 } } })).state).toBe('invalid');
	});

	it('accepts a version-1 lockfile that has no packages map', () => {
		expect(fingerprint('package-lock.json', JSON.stringify({ version: '1.0.30' })).state).toBe('ok');
	});

	it('ignores fields other than the version', () => {
		const a = fingerprint('package.json', pkg('1.0.30', { dependencies: { a: '1' } }));
		const b = fingerprint('package.json', pkg('1.0.30', { dependencies: { a: '2', b: '1' } }));
		expect(a).toEqual(b);
	});

	it('treats any versions.json entry change as a version change, regardless of key order', () => {
		const a = fingerprint('versions.json', versions({ '1.0.29': '1.11.4', '1.0.30': '1.11.4' }));
		const reordered = fingerprint('versions.json', versions({ '1.0.30': '1.11.4', '1.0.29': '1.11.4' }));
		const added = fingerprint('versions.json', versions({ '1.0.29': '1.11.4', '1.0.30': '1.11.4', '1.0.31': '1.11.4' }));
		expect(a).toEqual(reordered);
		expect(a).not.toEqual(added);
	});

	it('reads both the top-level and the root-package version in package-lock.json', () => {
		const text = JSON.stringify({ version: '1.0.30', packages: { '': { version: '1.0.31' } } });
		const fp = fingerprint('package-lock.json', text);
		expect(fp.state === 'ok' && fp.value).toContain('1.0.31');
	});
});

describe('verdicts: both directions', () => {
	it('passes when nothing guarded changed, with no label', () => {
		expect(verdictFor(baseTexts(), []).ok).toBe(true);
	});

	it('passes an ordinary change to package.json that leaves the version alone', () => {
		const head = { ...baseTexts(), 'package.json': pkg('1.0.30', { devDependencies: { y: '1' } }) };
		expect(verdictFor(head, []).ok).toBe(true);
	});

	it.each([
		['manifest.json', manifest('1.0.31')],
		['package.json', pkg('1.0.31')],
		['versions.json', versions({ '1.0.30': '1.11.4', '1.0.31': '1.11.4' })],
		['package-lock.json', lock('1.0.31')],
	])('fails a non-release PR that bumps the version in %s', (file, text) => {
		const head = { ...baseTexts(), [file]: text };
		const changes = findVersionChanges(baseTexts(), head).changes;
		const verdict = evaluate({ changes, labels: ['bug', 'docs'] });
		expect(changes.map((c) => c.file)).toEqual([file]);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain(file);
		expect(verdict.reason).toContain(RELEASE_LABEL);
	});

	it('passes the same bump when the PR carries the release label (case-insensitive, trimmed)', () => {
		const head = { ...baseTexts(), 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') };
		expect(verdictFor(head, ['Release']).ok).toBe(true);
		expect(verdictFor(head, [' release ']).ok).toBe(true);
	});

	it('does not accept a look-alike label or a branch-style name', () => {
		const head = { ...baseTexts(), 'manifest.json': manifest('1.0.31') };
		expect(verdictFor(head, ['releases', 'pre-release', 'release/1.0.31']).ok).toBe(false);
	});

	it('flags a guarded file that is added or removed as a change', () => {
		const head = { ...baseTexts(), 'versions.json': null };
		expect(findVersionChanges(baseTexts(), head).changes.map((c) => c.file)).toEqual(['versions.json']);
	});
});

describe('malformed input fails closed, whatever the label says', () => {
	it('fails a valid-to-malformed change without the label, and WITH the release label', () => {
		const head = { ...baseTexts(), 'manifest.json': '{ broken' };
		expect(verdictFor(head, []).ok).toBe(false);
		const withLabel = verdictFor(head, ['release']);
		expect(withLabel.ok).toBe(false);
		expect(withLabel.invalidInput).toBe(true);
	});

	it('fails when the base and the head are both malformed, even if they differ', () => {
		const base = { ...baseTexts(), 'package.json': '{ one' };
		const head = { ...baseTexts(), 'package.json': '{ two' };
		const verdict = verdictFor(head, ['release'], base);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('package.json');
	});

	it('names each side that could not be compared', () => {
		const base = { ...baseTexts(), 'versions.json': '[]' };
		const head = { ...baseTexts(), 'manifest.json': '[]' };
		const { invalid } = findVersionChanges(base, head);
		expect(invalid.map((i) => `${i.file}:${i.side}`)).toEqual(['manifest.json:head', 'versions.json:base']);
	});
});

describe('labels and arguments', () => {
	it('parses a comma list for local use and drops blanks', () => {
		expect(parseLabels('a, b ,,c')).toEqual(['a', 'b', 'c']);
		expect(parseLabels(undefined)).toEqual([]);
		expect(hasReleaseLabel(['x', 'RELEASE'])).toBe(true);
	});

	it('keeps a label that contains a comma as ONE label when read from JSON', () => {
		const parsed = parseLabelsJson(JSON.stringify(['docs,release']));
		expect(parsed).toEqual({ ok: true, labels: ['docs,release'] });
		expect(parsed.ok && hasReleaseLabel(parsed.labels)).toBe(false);
	});

	it('rejects labels that are not a JSON array of strings, and treats empty as no labels', () => {
		expect(parseLabelsJson('not json').ok).toBe(false);
		expect(parseLabelsJson('{"a":1}').ok).toBe(false);
		expect(parseLabelsJson('[1,2]').ok).toBe(false);
		expect(parseLabelsJson('')).toEqual({ ok: true, labels: [] });
		expect(parseLabelsJson(undefined)).toEqual({ ok: true, labels: [] });
	});

	it('requires both refs and rejects unknown flags', () => {
		expect(() => parseArgs(['--base', 'a'])).toThrow(/required/);
		expect(() => parseArgs(['--base', 'a', '--head', 'b', '--nope'])).toThrow(/unknown/);
		expect(parseArgs(['--base', 'a', '--head', 'b', '--labels', 'x'])).toEqual({ base: 'a', head: 'b', labels: 'x' });
	});
});

describe('the workflow contract (trust boundary and event coverage)', () => {
	const workflow = load(readFileSync(join(__dirname, '..', '.github', 'workflows', 'version-guard.yml'), 'utf8')) as {
		on: { pull_request_target?: { branches?: string[]; types?: string[] }; pull_request?: unknown };
		permissions: Record<string, string>;
		jobs: Record<string, { steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>;
	};

	it('uses pull_request_target, so the guard and workflow come from the base branch', () => {
		expect(workflow.on.pull_request_target).toBeDefined();
		expect(workflow.on.pull_request).toBeUndefined();
	});

	it('re-runs on every event that can change the verdict, including a retarget (edited) and label changes', () => {
		expect(workflow.on.pull_request_target?.types).toEqual(
			expect.arrayContaining(['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'unlabeled']),
		);
	});

	it('is read-only and never checks out or runs code from the PR head', () => {
		expect(workflow.permissions).toEqual({ contents: 'read' });
		const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
		for (const step of steps) {
			if (step.uses?.startsWith('actions/checkout')) expect(step.with?.ref).toBeUndefined();
			expect(step.run ?? '').not.toMatch(/npm (ci|install)|checkout .*pr-head|pr-head\//);
		}
	});
});

describe('main against a real git repository', () => {
	let dir: string;
	let out: string[];
	let err: string[];
	const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
			cwd: dir,
			encoding: 'utf8',
		}).trim();
	const writeAll = (texts: Record<string, string>) => {
		for (const [f, t] of Object.entries(texts)) writeFileSync(join(dir, f), t);
	};
	const commitAll = (msg: string) => {
		git('add', '-A');
		git('commit', '-q', '-m', msg);
		return git('rev-parse', 'HEAD');
	};
	const run = (base: string, head: string, env: Record<string, string> = {}, extra: string[] = []) =>
		main(['--base', base, '--head', head, ...extra], env, dir, io());

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'version-guard-'));
		out = [];
		err = [];
		// An empty template keeps a developer's global git template hooks out of the temporary repository.
		git('init', '-q', '--template=', '-b', 'main');
		writeAll(baseTexts() as Record<string, string>);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('fails a branch that bumps manifest.json and package.json without the label', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'feature');
		writeAll({ 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') });
		const head = commitAll('bump');
		expect(run(base, head, { PR_LABELS_JSON: JSON.stringify(['bug']) })).toBe(1);
		expect(err.join('\n')).toContain('manifest.json');
	});

	it('passes the same branch when the release label is present (JSON from CI, or the local flag)', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'release-branch');
		writeAll({ 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') });
		const head = commitAll('bump');
		expect(run(base, head, { PR_LABELS_JSON: JSON.stringify(['docs', 'release']) })).toBe(0);
		expect(run(base, head, {}, ['--labels', 'release'])).toBe(0);
		expect(out.join('\n')).toContain('release PR');
	});

	it('does not let a label named "docs,release" stand in for the release label', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'sneaky');
		writeAll({ 'manifest.json': manifest('1.0.31') });
		const head = commitAll('bump');
		expect(run(base, head, { PR_LABELS_JSON: JSON.stringify(['docs,release']) })).toBe(1);
	});

	it('fails closed (exit 2) on malformed label JSON and on a malformed manifest, even with the release label', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'broken');
		writeAll({ 'manifest.json': '{ broken' });
		const head = commitAll('break the manifest');
		expect(run(base, head, { PR_LABELS_JSON: JSON.stringify(['release']) })).toBe(2);
		expect(run(base, head, { PR_LABELS_JSON: 'not json' })).toBe(2);
	});

	it('passes a branch with no version change', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'docs');
		writeFileSync(join(dir, 'README.md'), 'hello');
		const head = commitAll('docs');
		expect(run(base, head)).toBe(0);
		expect(out.join('\n')).toContain('OK');
	});

	it('does not blame a PR for a version bump that landed on the base after it branched', () => {
		const root = commitAll('base');
		git('switch', '-q', '-c', 'feature');
		writeFileSync(join(dir, 'a.txt'), 'x');
		const head = commitAll('feature work');
		git('switch', '-q', 'main');
		writeAll({ 'manifest.json': manifest('1.0.31') });
		const newBase = commitAll('release landed on main');
		expect(root).not.toBe(newBase);
		expect(run(newBase, head)).toBe(0);
	});

	it('fails closed (exit 2) when a ref cannot be resolved or an argument is missing', () => {
		commitAll('base');
		expect(run('does-not-exist', 'HEAD')).toBe(2);
		expect(main(['--base', 'HEAD'], {}, dir, io())).toBe(2);
	});
});
