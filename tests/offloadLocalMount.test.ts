import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { checkMountFolder, checkMountFolderWithin, collisionName, isSafeFileName, placeFile, resolveDestination } from '../src/services/offload/localMount';
import { hashStream, streamFingerprinter, type NodeDeps } from '../src/services/offload/fingerprint';

// The mount code idles with window timers (Obsidian popout-window safe); node has no window.
vi.stubGlobal('window', globalThis);

const deps = { fs, path, crypto } as unknown as NodeDeps;
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

let tmp: string;
let mount: string;
let vault: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-offload-'));
	mount = path.join(tmp, 'drive');
	vault = path.join(tmp, 'vault');
	fs.mkdirSync(mount);
	fs.mkdirSync(vault);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('isSafeFileName', () => {
	it.each(['report.pdf', 'My file (1).pdf', 'a-b_c.MP4'])('accepts %s', (n) => expect(isSafeFileName(n)).toBe(true));
	it.each(['', '.', '..', 'a/b.pdf', 'a\\b.pdf', 'con.pdf', 'NUL', 'com1.txt', 'trailing.', 'trailing ', 'a:b.pdf', 'x'.repeat(201), 'q?.pdf', 'tab\tname'])('refuses %j', (n) => expect(isSafeFileName(n)).toBe(false));
});

describe('checkMountFolder', () => {
	it('returns the canonical path of an existing directory and writes nothing', async () => {
		const res = await checkMountFolder(deps, mount);
		expect(res.ok && res.value).toBe(fs.realpathSync(mount));
		expect(fs.readdirSync(mount)).toEqual([]);
	});

	it('refuses relative, missing and non-directory paths', async () => {
		expect(await checkMountFolder(deps, '')).toEqual({ ok: false, error: 'mount-invalid' });
		expect(await checkMountFolder(deps, 'relative/dir')).toEqual({ ok: false, error: 'mount-invalid' });
		expect(await checkMountFolder(deps, path.join(tmp, 'nope'))).toEqual({ ok: false, error: 'mount-missing' });
		const file = path.join(tmp, 'f.txt');
		fs.writeFileSync(file, 'x');
		expect(await checkMountFolder(deps, file)).toEqual({ ok: false, error: 'mount-invalid' });
	});

	it('refuses the vault itself, a folder inside it and a folder that contains it, and accepts one outside', async () => {
		const inside = path.join(vault, 'Attachments');
		fs.mkdirSync(inside);
		expect(await checkMountFolder(deps, vault, vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
		expect(await checkMountFolder(deps, inside, vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
		expect(await checkMountFolder(deps, tmp, vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
		const ok = await checkMountFolder(deps, mount, vault);
		expect(ok.ok).toBe(true);
	});

	it('does not mistake a folder whose name starts with dots for a way out of the vault', async () => {
		const dotted = path.join(vault, '..Drive');
		fs.mkdirSync(dotted);
		expect(await checkMountFolder(deps, dotted, vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
	});

	it('says no when the vault folder cannot be resolved, instead of guessing from the text of the path', async () => {
		expect(await checkMountFolder(deps, mount, path.join(tmp, 'missing-vault'))).toEqual({ ok: false, error: 'mount-vault-unverified' });
	});

	it('does not mistake a sibling whose name starts like the vault for the vault', async () => {
		const sibling = path.join(tmp, 'vault-archive');
		fs.mkdirSync(sibling);
		expect((await checkMountFolder(deps, sibling, vault)).ok).toBe(true);
	});

	it('behaves as before when no vault folder is given', async () => {
		expect((await checkMountFolder(deps, vault)).ok).toBe(true);
		expect((await checkMountFolder(deps, vault, '')).ok).toBe(true);
	});
});

describe('resolveDestination', () => {
	it('stays inside the root and refuses names that could leave it', async () => {
		const root = fs.realpathSync(mount);
		const ok = await resolveDestination(deps, root, 'a.pdf');
		expect(ok).toEqual({ ok: true, value: path.join(root, 'a.pdf') });
		for (const bad of ['../a.pdf', 'sub/a.pdf', '..', 'CON']) expect(await resolveDestination(deps, root, bad)).toEqual({ ok: false, error: 'name-invalid' });
	});

	it('refuses an existing symlink at the destination', async () => {
		const root = fs.realpathSync(mount);
		const outside = path.join(tmp, 'outside.txt');
		fs.writeFileSync(outside, 'secret');
		try {
			fs.symlinkSync(outside, path.join(root, 'link.pdf'));
		} catch {
			return; // symlinks need privileges on some Windows setups
		}
		expect(await resolveDestination(deps, root, 'link.pdf')).toEqual({ ok: false, error: 'name-invalid' });
	});
});

describe('placeFile', () => {
	const expectedOf = (data: Buffer) => ({ sha256: sha(data), size: data.length });
	let src: string;
	const data = Buffer.from('x'.repeat(3_000_000) + 'tail');

	beforeEach(() => {
		src = path.join(vault, 'Big.pdf');
		fs.writeFileSync(src, data);
	});

	it('copies a large file by streaming and verifies the destination', async () => {
		const root = fs.realpathSync(mount);
		const seen: number[] = [];
		const res = await placeFile(deps, root, src, 'Big.pdf', expectedOf(data), { onProgress: (b) => seen.push(b) });
		expect(res).toMatchObject({ ok: true, value: { destName: 'Big.pdf', reused: false, size: data.length, sha256: sha(data) } });
		expect(fs.readFileSync(path.join(root, 'Big.pdf')).equals(data)).toBe(true);
		expect(seen[seen.length - 1]).toBe(data.length);
		expect(fs.existsSync(src)).toBe(true); // the local file is never touched here
	});

	it('reuses an identical file that is already there', async () => {
		const root = fs.realpathSync(mount);
		fs.writeFileSync(path.join(root, 'Big.pdf'), data);
		const res = await placeFile(deps, root, src, 'Big.pdf', expectedOf(data));
		expect(res).toMatchObject({ ok: true, value: { reused: true, destName: 'Big.pdf' } });
	});

	it('does not count the source itself, or a hard link to it, as an independent copy', async () => {
		const here = fs.realpathSync(vault);
		expect(await placeFile(deps, here, src, 'Big.pdf', expectedOf(data))).toEqual({ ok: false, error: 'dest-conflict' });
		expect(fs.existsSync(src)).toBe(true);
		const root = fs.realpathSync(mount);
		fs.linkSync(src, path.join(root, 'Big.pdf'));
		expect(await placeFile(deps, root, src, 'Big.pdf', expectedOf(data))).toEqual({ ok: false, error: 'dest-conflict' });
	});

	it('never overwrites a different file: it writes a hash-suffixed name', async () => {
		const root = fs.realpathSync(mount);
		fs.writeFileSync(path.join(root, 'Big.pdf'), 'someone else\'s file');
		const res = await placeFile(deps, root, src, 'Big.pdf', expectedOf(data));
		const name = collisionName('Big.pdf', sha(data));
		expect(res).toMatchObject({ ok: true, value: { destName: name, reused: false } });
		expect(fs.readFileSync(path.join(root, 'Big.pdf'), 'utf8')).toBe('someone else\'s file');
		expect(fs.readFileSync(path.join(root, name)).equals(data)).toBe(true);
	});

	it('stops with a conflict when even the suffixed name holds something else', async () => {
		const root = fs.realpathSync(mount);
		fs.writeFileSync(path.join(root, 'Big.pdf'), 'one');
		fs.writeFileSync(path.join(root, collisionName('Big.pdf', sha(data))), 'two');
		expect(await placeFile(deps, root, src, 'Big.pdf', expectedOf(data))).toEqual({ ok: false, error: 'dest-conflict' });
	});

	it('removes the copy and reports a change when the source differs from what was fingerprinted', async () => {
		const root = fs.realpathSync(mount);
		const res = await placeFile(deps, root, src, 'Big.pdf', { sha256: sha('different'), size: data.length });
		expect(res).toEqual({ ok: false, error: 'file-changed' });
		expect(fs.existsSync(path.join(root, 'Big.pdf'))).toBe(false);
	});

	it('cleans up a partial copy when cancelled, without touching other files', async () => {
		const root = fs.realpathSync(mount);
		fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
		const ctl = new AbortController();
		ctl.abort();
		expect(await placeFile(deps, root, src, 'Big.pdf', expectedOf(data), { signal: ctl.signal })).toEqual({ ok: false, error: 'cancelled' });
		expect(fs.readdirSync(root)).toEqual(['keep.txt']);
	});

	it('removes only its own partial file when the source disappears mid-copy, and waits for the stream', async () => {
		const root = fs.realpathSync(mount);
		const gone = path.join(vault, 'ghost.pdf'); // never existed: the read stream fails to open
		const res = await placeFile(deps, root, gone, 'Ghost.pdf', { sha256: sha('x'), size: 1 });
		expect(res.ok).toBe(false);
		expect(fs.readdirSync(root)).toEqual([]);
		// an existing file of the same name is not touched by a failed attempt that did not create it
		fs.writeFileSync(path.join(root, 'Keep.pdf'), 'mine');
		const second = await placeFile(deps, root, gone, 'Keep.pdf', { sha256: sha('x'), size: 1 });
		expect(second.ok).toBe(false);
		expect(fs.readFileSync(path.join(root, 'Keep.pdf'), 'utf8')).toBe('mine');
	});

	it('refuses an unsafe name before writing anything', async () => {
		const root = fs.realpathSync(mount);
		expect(await placeFile(deps, root, src, '../escape.pdf', expectedOf(data))).toEqual({ ok: false, error: 'name-invalid' });
		expect(fs.readdirSync(tmp).sort()).toEqual(['drive', 'vault']);
	});
});

describe('fingerprint', () => {
	it('hashes a stream and a stable file, and reports a missing one', async () => {
		const file = path.join(vault, 'a.bin');
		fs.writeFileSync(file, 'hello');
		expect(await hashStream(deps, file)).toEqual({ ok: true, value: { sha256: sha('hello'), bytes: 5 } });
		const fp = streamFingerprinter(deps);
		const res = await fp(file);
		expect(res.ok && res.value).toMatchObject({ size: 5, sha256: sha('hello') });
		expect(await fp(path.join(vault, 'missing.bin'))).toMatchObject({ ok: false });
	});

	it('rejects a file that was replaced by another with the same size and time', async () => {
		const file = path.join(vault, 'a.bin');
		fs.writeFileSync(file, 'hello');
		let calls = 0;
		const real = fs.promises.stat;
		const fake = {
			...deps,
			fs: { ...fs, promises: { ...fs.promises, stat: async (p: string) => { const s = await real(p); calls++; return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: calls }); } } },
		} as unknown as NodeDeps;
		expect(await streamFingerprinter(fake)(file)).toEqual({ ok: false, error: 'file-changed' });
	});

	it('survives a progress callback that throws', async () => {
		const file = path.join(vault, 'a.bin');
		fs.writeFileSync(file, 'hello');
		expect(await hashStream(deps, file, { onProgress: () => { throw new Error('ui bug'); } })).toEqual({ ok: true, value: { sha256: sha('hello'), bytes: 5 } });
	});

	it('honours cancellation', async () => {
		const file = path.join(vault, 'a.bin');
		fs.writeFileSync(file, 'hello');
		const ctl = new AbortController();
		ctl.abort();
		expect(await streamFingerprinter(deps)(file, { signal: ctl.signal })).toEqual({ ok: false, error: 'cancelled' });
	});
});

describe('checkMountFolderWithin', () => {
	it('answers like checkMountFolder when the folder answers in time', async () => {
		const res = await checkMountFolderWithin(deps, mount);
		expect(res.ok && res.value).toBe(fs.realpathSync(mount));
		expect(await checkMountFolderWithin(deps, path.join(tmp, 'nope'))).toEqual({ ok: false, error: 'mount-missing' });
	});

	it('gives up with mount-slow when the probe hangs, and ignores its late answer', async () => {
		vi.useFakeTimers();
		try {
			let release = (): void => undefined;
			const hang = new Promise<string>((_, reject) => { release = () => reject(new Error('gone')); });
			const slowDeps = { ...deps, fs: { promises: { realpath: () => hang, stat: () => hang } } } as unknown as NodeDeps;
			const pending = checkMountFolderWithin(slowDeps, mount, undefined, 5000);
			await vi.advanceTimersByTimeAsync(5000);
			expect(await pending).toEqual({ ok: false, error: 'mount-slow' });
			release(); // the abandoned probe finally settles, so it stops counting against the limit
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not leave its timer running after a prompt answer', async () => {
		vi.useFakeTimers();
		try {
			await checkMountFolderWithin(deps, mount, undefined, 5000);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('checkMountFolderWithin bounds abandoned probes', () => {
	it('reuses a pending probe for the same folder, and refuses more than three unresolved', async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			let release = (): void => undefined;
			const hang = new Promise<string>((_, reject) => { release = () => reject(new Error('gone')); });
			const slowDeps = { ...deps, fs: { promises: { realpath: () => { calls++; return hang; }, stat: () => hang } } } as unknown as NodeDeps;
			const ask = async (root: string): Promise<unknown> => {
				const pending = checkMountFolderWithin(slowDeps, root, undefined, 1000);
				await vi.advanceTimersByTimeAsync(1000);
				return pending;
			};
			const a = path.join(tmp, 'a');
			expect(await ask(a)).toEqual({ ok: false, error: 'mount-slow' });
			expect(await ask(a)).toEqual({ ok: false, error: 'mount-slow' });
			expect(calls).toBe(1); // the second click reused the first probe
			await ask(path.join(tmp, 'b'));
			await ask(path.join(tmp, 'c'));
			expect(calls).toBe(3);
			expect(await ask(path.join(tmp, 'd'))).toEqual({ ok: false, error: 'mount-slow' });
			expect(calls).toBe(3); // a fourth unresolved probe was refused, not started
			release();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
