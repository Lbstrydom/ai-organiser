/**
 * Private staged-file guard + hook installer.
 * Unit tests over the pure checker, then temp-repo integration tests (real git).
 * Fixtures are synthetic: the "marker" below is a made-up string.
 */
import { vi, describe, it, expect, afterEach } from 'vitest';

// These tests spawn git and node child processes; under full-suite load the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000 });
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	checkStaged,
	globToRegExp,
	parseRawDiff,
	run,
	DEFAULT_PATH_RULES,
} from '../scripts/check-private-staged.mjs';
import { buildHookScript, planInstall, installHook, resolveHooksDir, HOOK_MARKER } from '../scripts/install-private-hook.mjs';

const GUARD_SCRIPT = resolve(__dirname, '..', 'scripts', 'check-private-staged.mjs');
const MARKER = 'zz-synthetic-marker-7f3a';

const noBlob = () => null;

describe('globToRegExp', () => {
	it('treats ** as crossing folders and * as staying in one', () => {
		expect(globToRegExp('docs/plans/**').test('docs/plans/a/b.md')).toBe(true);
		expect(globToRegExp('docs/plans/**').test('docs/plansx/a.md')).toBe(false);
		expect(globToRegExp('**/agent-index*.jsonl*').test('a/b/agent-index.jsonl.aio-prev')).toBe(true);
		expect(globToRegExp('**/agent-index*.jsonl*').test('agent-index.jsonl')).toBe(true);
		expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
	});
});

describe('checkStaged (pure)', () => {
	it('flags every default private path (positive controls)', () => {
		for (const path of [
			'.vault-private/guard.json',
			'docs/plans/x.md',
			'docs/completed/y.md',
			'.ai-organiser/agent-index.jsonl',
			'notes/agent-index.jsonl.aio-prev',
		]) {
			const res = checkStaged([{ status: 'A', path }], noBlob);
			expect(res.ok, path).toBe(false);
		}
	});

	it('passes ordinary files (negative control)', () => {
		const res = checkStaged(
			[
				{ status: 'M', path: 'src/main.ts' },
				{ status: 'A', path: 'docs/features/platform.md' },
			],
			noBlob,
		);
		expect(res).toEqual({ ok: true, violations: [] });
	});

	it('catches a rename into a private path via the new path, and out of one via the old path', () => {
		expect(checkStaged([{ status: 'R', oldPath: 'src/a.ts', path: 'docs/plans/a.ts' }], noBlob).ok).toBe(false);
		expect(checkStaged([{ status: 'R', oldPath: 'docs/plans/a.md', path: 'docs/features/a.md' }], noBlob).ok).toBe(false);
	});

	it('ignores deletions', () => {
		expect(checkStaged([{ status: 'D', path: 'docs/plans/old.md' }], noBlob).ok).toBe(true);
	});

	it('flags a content marker without printing its value', () => {
		const res = checkStaged(
			[{ status: 'M', path: 'src/a.ts' }],
			() => `x ${MARKER.toUpperCase()} y`,
			{ markers: [MARKER] },
		);
		expect(res.ok).toBe(false);
		expect(JSON.stringify(res)).not.toContain(MARKER);
		expect(res.violations[0].rule).toBe('content-marker');
	});

	it('does not read blobs for already-blocked paths', () => {
		let reads = 0;
		checkStaged([{ status: 'A', path: 'docs/plans/x.md' }], () => (reads++, 'ok'), { markers: [MARKER] });
		expect(reads).toBe(0);
	});

	it('ignores empty and non-string markers', () => {
		const res = checkStaged([{ status: 'M', path: 'a.ts' }], () => 'anything', { markers: ['', 5 as unknown as string] });
		expect(res.ok).toBe(true);
	});

	it('exposes the default rules', () => {
		expect(DEFAULT_PATH_RULES).toContain('.vault-private/**');
	});
});

describe('parseRawDiff', () => {
	it('parses plain and rename records from -z output', () => {
		const out =
			':100644 100644 aaa bbb M\0src/a.ts\0' + ':100644 100644 ccc ddd R100\0old/b.ts\0new/b.ts\0';
		expect(parseRawDiff(out)).toEqual([
			{ status: 'M', path: 'src/a.ts', blob: 'bbb' },
			{ status: 'R', oldPath: 'old/b.ts', path: 'new/b.ts', blob: 'ddd' },
		]);
	});
});

describe('buildHookScript / planInstall', () => {
	it('quotes the absolute path and sets the opt-in flag', () => {
		const text = buildHookScript('C:\\a b\\guard.mjs');
		expect(text).toContain('AIO_PRIVATE_GUARD=1 node "C:/a b/guard.mjs"');
		expect(text).toContain(HOOK_MARKER);
	});

	it('creates, updates its own hook, and refuses a foreign one', () => {
		expect(planInstall(null).action).toBe('create');
		expect(planInstall(`#!/bin/sh\n${HOOK_MARKER}\n`).action).toBe('update');
		expect(planInstall('#!/bin/sh\necho hi\n').action).toBe('refuse');
	});
});

// ---- temp-repo integration ------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length) {
		const d = tempDirs.pop() as string;
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

function git(cwd: string, args: string[]) {
	const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function makeRepo(name = 'repo'): string {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'aio-guard-')));
	tempDirs.push(base);
	const dir = join(base, name);
	mkdirSync(dir);
	git(dir, ['init', '-q', '-b', 'main']);
	git(dir, ['config', 'user.email', 'test@example.com']);
	git(dir, ['config', 'user.name', 'Test']);
	git(dir, ['config', 'commit.gpgsign', 'false']);
	return dir;
}

function writeGuardConfig(dir: string) {
	mkdirSync(join(dir, '.vault-private'), { recursive: true });
	writeFileSync(join(dir, '.vault-private', 'guard.json'), JSON.stringify({ markers: [MARKER] }));
	writeFileSync(join(dir, '.gitignore'), '.vault-private/\n');
}

describe('run (temp repo)', () => {
	it('exits 0 and does nothing without the opt-in flag', () => {
		const dir = makeRepo();
		const lines: string[] = [];
		expect(run({ cwd: dir, env: {}, log: (l) => lines.push(l) })).toBe(0);
		expect(lines.join('\n')).toContain('not installed');
	});

	it('exits 0 for an empty index even when the config is missing', () => {
		const dir = makeRepo();
		expect(run({ cwd: dir, env: { AIO_PRIVATE_GUARD: '1' }, log: () => {} })).toBe(0);
	});

	it('fails closed (2) when the index is non-empty and the config is missing', () => {
		const dir = makeRepo();
		writeFileSync(join(dir, 'a.txt'), 'hello');
		git(dir, ['add', 'a.txt']);
		expect(run({ cwd: dir, env: { AIO_PRIVATE_GUARD: '1' }, log: () => {} })).toBe(2);
	});

	it('blocks a staged marker even when the working tree was cleaned afterwards', () => {
		const dir = makeRepo();
		writeGuardConfig(dir);
		writeFileSync(join(dir, 'a.txt'), `leak ${MARKER}`);
		git(dir, ['add', 'a.txt']);
		writeFileSync(join(dir, 'a.txt'), 'clean now'); // staged-vs-working-tree divergence
		const lines: string[] = [];
		expect(run({ cwd: dir, env: { AIO_PRIVATE_GUARD: '1' }, log: (l) => lines.push(l) })).toBe(1);
		expect(lines.join('\n')).not.toContain(MARKER);
	});

	it('passes a clean staged file', () => {
		const dir = makeRepo();
		writeGuardConfig(dir);
		writeFileSync(join(dir, 'a.txt'), 'fine');
		git(dir, ['add', 'a.txt']);
		expect(run({ cwd: dir, env: { AIO_PRIVATE_GUARD: '1' }, log: () => {} })).toBe(0);
	});

	it('blocks a force-added docs/plans file', () => {
		const dir = makeRepo();
		writeGuardConfig(dir);
		mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
		writeFileSync(join(dir, 'docs', 'plans', 'p.md'), 'plan');
		git(dir, ['add', '-f', 'docs/plans/p.md']);
		expect(run({ cwd: dir, env: { AIO_PRIVATE_GUARD: '1' }, log: () => {} })).toBe(1);
	});
});

describe('installHook (temp repo)', () => {
	it('installs into the default hooks dir, idempotently, and blocks a real commit', () => {
		const dir = makeRepo('path with spaces');
		writeGuardConfig(dir);
		const first = installHook({ cwd: dir, guardScriptPath: GUARD_SCRIPT });
		expect(first.ok).toBe(true);
		const second = installHook({ cwd: dir, guardScriptPath: GUARD_SCRIPT });
		expect(second.ok).toBe(true);
		const hook = readFileSync(join(resolveHooksDir(dir), 'pre-commit'), 'utf8');
		expect(hook.split(HOOK_MARKER).length).toBe(2); // exactly one copy

		writeFileSync(join(dir, 'a.txt'), `leak ${MARKER}`);
		git(dir, ['add', 'a.txt']);
		const blocked = git(dir, ['commit', '-q', '-m', 'x']);
		expect(blocked.status).not.toBe(0);
		expect(blocked.out).not.toContain(MARKER);

		writeFileSync(join(dir, 'a.txt'), 'fine');
		git(dir, ['add', 'a.txt']);
		expect(git(dir, ['commit', '-q', '-m', 'x']).status).toBe(0);
	});

	it('respects core.hooksPath', () => {
		const dir = makeRepo();
		const custom = join(dir, 'custom-hooks');
		git(dir, ['config', 'core.hooksPath', 'custom-hooks']);
		const res = installHook({ cwd: dir, guardScriptPath: GUARD_SCRIPT });
		expect(res.ok).toBe(true);
		expect(existsSync(join(custom, 'pre-commit'))).toBe(true);
	});

	it('refuses to overwrite a foreign pre-commit hook', () => {
		const dir = makeRepo();
		const hooks = resolveHooksDir(dir);
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n');
		const res = installHook({ cwd: dir, guardScriptPath: GUARD_SCRIPT });
		expect(res.ok).toBe(false);
		expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain('echo mine');
	});

	it('resolves the shared hooks dir from a linked worktree', () => {
		const dir = makeRepo();
		writeFileSync(join(dir, 'a.txt'), 'x');
		git(dir, ['add', 'a.txt']);
		git(dir, ['commit', '-q', '-m', 'init']);
		const wt = join(dir, '..', 'linked');
		expect(git(dir, ['worktree', 'add', '-q', wt, '-b', 'side']).status).toBe(0);
		expect(realpathSync(resolveHooksDir(wt))).toBe(realpathSync(resolveHooksDir(dir)));
	});
});
