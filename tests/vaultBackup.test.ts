import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	backupTargets, restoreBackup, latestBackup, resolveTargets, stamp, BACKUP_FILES,
} from '../scripts/persona-harness/vault-backup.mjs';

const quiet = () => {};

describe('vault backup / restore', () => {
	let tmp: string;
	let target: string;
	let backups: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'aio-vault-backup-'));
		target = join(tmp, 'plugin');
		backups = join(tmp, 'backups');
		mkdirSync(target);
		writeFileSync(join(target, 'main.js'), 'main-v1');
		writeFileSync(join(target, 'manifest.json'), '{"v":1}');
		writeFileSync(join(target, 'data.json'), '{"setting":"original"}');
		// styles.css deliberately absent: a missing file is skipped, not an error
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it('is a no-op with a message when no target is configured', () => {
		const lines: string[] = [];
		expect(backupTargets([], { backupRoot: backups, log: (m: string) => lines.push(m) })).toBeNull();
		expect(lines[0]).toContain('no deploy target');
		expect(existsSync(backups)).toBe(false);
	});

	it('copies the plugin files into a timestamped folder and skips missing ones', () => {
		const now = new Date('2026-11-15T18:55:11.123Z');
		const dir = backupTargets([target], { backupRoot: backups, now, log: quiet })!;
		expect(dir.endsWith(stamp(now))).toBe(true);
		expect(readFileSync(join(dir, '0', 'main.js'), 'utf8')).toBe('main-v1');
		expect(readFileSync(join(dir, '0', 'data.json'), 'utf8')).toBe('{"setting":"original"}');
		expect(existsSync(join(dir, '0', 'styles.css'))).toBe(false);
		expect(BACKUP_FILES).toContain('data.json');
	});

	it('never reuses a backup folder, even within the same millisecond', () => {
		const now = new Date('2026-03-03T03:03:03.003Z');
		const a = backupTargets([target], { backupRoot: backups, now, log: quiet });
		const b = backupTargets([target], { backupRoot: backups, now, log: quiet });
		expect(a).not.toBe(b);
		expect(existsSync(join(a!, 'meta.json'))).toBe(true);
		expect(existsSync(join(b!, 'meta.json'))).toBe(true);
	});

	it('restore removes a file the run created that was absent at backup time', () => {
		const dir = backupTargets([target], { backupRoot: backups, log: quiet })!;
		writeFileSync(join(target, 'styles.css'), 'created-by-run');
		restoreBackup(dir, { log: quiet });
		expect(existsSync(join(target, 'styles.css'))).toBe(false);
	});

	it('stores absolute target paths', () => {
		const dir = backupTargets([target], { backupRoot: backups, log: quiet })!;
		const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
		expect(meta.entries[0].target).toBe(resolve(target));
	});

	it('skips a target that does not exist', () => {
		expect(backupTargets([join(tmp, 'nope')], { backupRoot: backups, log: quiet })).toBeNull();
	});

	it('restores the backed-up files over a changed target, leaving other files alone', () => {
		const dir = backupTargets([target], { backupRoot: backups, log: quiet })!;
		writeFileSync(join(target, 'main.js'), 'main-v2-from-persona-run');
		writeFileSync(join(target, 'data.json'), '{"setting":"changed"}');
		writeFileSync(join(target, 'other.txt'), 'untouched');
		restoreBackup(dir, { log: quiet });
		expect(readFileSync(join(target, 'main.js'), 'utf8')).toBe('main-v1');
		expect(readFileSync(join(target, 'data.json'), 'utf8')).toBe('{"setting":"original"}');
		expect(readFileSync(join(target, 'other.txt'), 'utf8')).toBe('untouched');
	});

	it('finds the newest backup and rejects a folder that is not one', () => {
		backupTargets([target], { backupRoot: backups, now: new Date('2026-01-01T00:00:00Z'), log: quiet });
		const newer = backupTargets([target], { backupRoot: backups, now: new Date('2026-02-01T00:00:00Z'), log: quiet });
		expect(latestBackup(backups)).toBe(newer);
		expect(latestBackup(join(tmp, 'none'))).toBeNull();
		expect(() => restoreBackup(tmp, { log: quiet })).toThrow(/not a vault backup/);
	});

	it('resolves targets from the env when no deploy.local.json exists', () => {
		const t = resolveTargets({ repoRoot: tmp, env: { AIORG_DEPLOY_TARGETS: 'a; b;;' } });
		expect(t).toEqual(['a', 'b']);
	});
});
