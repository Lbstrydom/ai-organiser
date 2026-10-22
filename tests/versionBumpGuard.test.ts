import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	RELEASE_LABEL,
	versionFingerprint,
	findVersionChanges,
	hasReleaseLabel,
	parseLabels,
	evaluate,
	parseArgs,
	main,
} from '../scripts/check-version-bump.mjs';

const manifest = (version: string) => JSON.stringify({ id: 'x', version, minAppVersion: '1.11.4' });
const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'x', version, ...extra });
const versions = (map: Record<string, string>) => JSON.stringify(map);
const lock = (version: string) => JSON.stringify({ name: 'x', version, packages: { '': { name: 'x', version } } });

const baseTexts = () => ({
	'manifest.json': manifest('1.0.30'),
	'package.json': pkg('1.0.30'),
	'versions.json': versions({ '1.0.30': '1.11.4' }),
	'package-lock.json': lock('1.0.30'),
});

describe('versionFingerprint', () => {
	it('returns null for an absent file and flags unparseable JSON', () => {
		expect(versionFingerprint('manifest.json', null)).toBeNull();
		expect(versionFingerprint('manifest.json', '{ not json')).toBe('<unparseable>');
		expect(versionFingerprint('manifest.json', 'null')).toBe('<unparseable>');
	});

	it('ignores fields other than the version', () => {
		expect(versionFingerprint('package.json', pkg('1.0.30', { dependencies: { a: '1' } }))).toBe(
			versionFingerprint('package.json', pkg('1.0.30', { dependencies: { a: '2', b: '1' } })),
		);
	});

	it('treats any versions.json entry change as a version change, regardless of key order', () => {
		const a = versionFingerprint('versions.json', versions({ '1.0.29': '1.11.4', '1.0.30': '1.11.4' }));
		const reordered = versionFingerprint('versions.json', versions({ '1.0.30': '1.11.4', '1.0.29': '1.11.4' }));
		const added = versionFingerprint('versions.json', versions({ '1.0.29': '1.11.4', '1.0.30': '1.11.4', '1.0.31': '1.11.4' }));
		expect(a).toBe(reordered);
		expect(a).not.toBe(added);
	});

	it('reads both the top-level and the root-package version in package-lock.json', () => {
		const text = JSON.stringify({ version: '1.0.30', packages: { '': { version: '1.0.31' } } });
		expect(versionFingerprint('package-lock.json', text)).toContain('1.0.31');
	});
});

describe('findVersionChanges and evaluate: both directions', () => {
	it('passes when nothing guarded changed, with no label', () => {
		const changes = findVersionChanges(baseTexts(), baseTexts());
		expect(changes).toEqual([]);
		expect(evaluate({ changes, labels: [] }).ok).toBe(true);
	});

	it('passes an ordinary change to package.json that leaves the version alone', () => {
		const head = { ...baseTexts(), 'package.json': pkg('1.0.30', { devDependencies: { y: '1' } }) };
		expect(evaluate({ changes: findVersionChanges(baseTexts(), head), labels: [] }).ok).toBe(true);
	});

	it.each([
		['manifest.json', manifest('1.0.31')],
		['package.json', pkg('1.0.31')],
		['versions.json', versions({ '1.0.30': '1.11.4', '1.0.31': '1.11.4' })],
		['package-lock.json', lock('1.0.31')],
	])('fails a non-release PR that bumps the version in %s', (file, text) => {
		const head = { ...baseTexts(), [file]: text };
		const changes = findVersionChanges(baseTexts(), head);
		const verdict = evaluate({ changes, labels: ['bug', 'docs'] });
		expect(changes.map((c) => c.file)).toEqual([file]);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain(file);
		expect(verdict.reason).toContain(RELEASE_LABEL);
	});

	it('passes the same bump when the PR carries the release label (case-insensitive, trimmed)', () => {
		const head = { ...baseTexts(), 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') };
		const changes = findVersionChanges(baseTexts(), head);
		expect(evaluate({ changes, labels: ['Release'] }).ok).toBe(true);
		expect(evaluate({ changes, labels: [' release '] }).ok).toBe(true);
	});

	it('does not accept a look-alike label or a branch-style name', () => {
		const head = { ...baseTexts(), 'manifest.json': manifest('1.0.31') };
		const changes = findVersionChanges(baseTexts(), head);
		expect(evaluate({ changes, labels: ['releases', 'pre-release', 'release/1.0.31'] }).ok).toBe(false);
	});

	it('fails closed when a guarded file becomes unparseable', () => {
		const head = { ...baseTexts(), 'manifest.json': '{ broken' };
		expect(evaluate({ changes: findVersionChanges(baseTexts(), head), labels: [] }).ok).toBe(false);
	});

	it('flags a guarded file that is added or removed', () => {
		const head = { ...baseTexts(), 'versions.json': null as unknown as string };
		expect(findVersionChanges(baseTexts(), head).map((c) => c.file)).toEqual(['versions.json']);
	});
});

describe('labels and arguments', () => {
	it('parses a comma list and drops blanks', () => {
		expect(parseLabels('a, b ,,c')).toEqual(['a', 'b', 'c']);
		expect(parseLabels(undefined)).toEqual([]);
		expect(hasReleaseLabel(['x', 'RELEASE'])).toBe(true);
	});

	it('requires both refs and rejects unknown flags', () => {
		expect(() => parseArgs(['--base', 'a'])).toThrow(/required/);
		expect(() => parseArgs(['--base', 'a', '--head', 'b', '--nope'])).toThrow(/unknown/);
		expect(parseArgs(['--base', 'a', '--head', 'b', '--labels', 'x'])).toEqual({ base: 'a', head: 'b', labels: 'x' });
	});
});

describe('main against a real git repository', () => {
	let dir: string;
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
	const silence = () => {
		const log = console.log;
		const err = console.error;
		console.log = () => undefined;
		console.error = () => undefined;
		return () => {
			console.log = log;
			console.error = err;
		};
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'version-guard-'));
		// An empty template keeps a developer's global git template hooks out of the temporary repository.
		git('init', '-q', '--template=', '-b', 'main');
		writeAll(baseTexts());
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('fails a branch that bumps manifest.json and package.json without the label', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'feature');
		writeAll({ 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') });
		const head = commitAll('bump');
		const restore = silence();
		try {
			expect(main(['--base', base, '--head', head], { PR_LABELS: 'bug' }, dir)).toBe(1);
		} finally {
			restore();
		}
	});

	it('passes the same branch when the release label is present (flag or environment)', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'release-branch');
		writeAll({ 'manifest.json': manifest('1.0.31'), 'package.json': pkg('1.0.31') });
		const head = commitAll('bump');
		const restore = silence();
		try {
			expect(main(['--base', base, '--head', head, '--labels', 'release'], {}, dir)).toBe(0);
			expect(main(['--base', base, '--head', head], { PR_LABELS: 'docs,release' }, dir)).toBe(0);
		} finally {
			restore();
		}
	});

	it('passes a branch with no version change', () => {
		const base = commitAll('base');
		git('switch', '-q', '-c', 'docs');
		writeFileSync(join(dir, 'README.md'), 'hello');
		const head = commitAll('docs');
		const restore = silence();
		try {
			expect(main(['--base', base, '--head', head], {}, dir)).toBe(0);
		} finally {
			restore();
		}
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
		const restore = silence();
		try {
			expect(main(['--base', newBase, '--head', head], {}, dir)).toBe(0);
		} finally {
			restore();
		}
	});

	it('fails closed (exit 2) when a ref cannot be resolved', () => {
		commitAll('base');
		const restore = silence();
		try {
			expect(main(['--base', 'does-not-exist', '--head', 'HEAD'], {}, dir)).toBe(2);
			expect(main(['--base', 'HEAD'], {}, dir)).toBe(2);
		} finally {
			restore();
		}
	});
});
