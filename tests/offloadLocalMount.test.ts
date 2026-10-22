import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { checkMountFolder, collisionName, isSafeFileName, placeFile, resolveDestination } from '../src/services/offload/localMount';
import { hashStream, streamFingerprinter, type NodeDeps } from '../src/services/offload/fingerprint';

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

	it('honours cancellation', async () => {
		const file = path.join(vault, 'a.bin');
		fs.writeFileSync(file, 'hello');
		const ctl = new AbortController();
		ctl.abort();
		expect(await streamFingerprinter(deps)(file, { signal: ctl.signal })).toEqual({ ok: false, error: 'cancelled' });
	});
});
