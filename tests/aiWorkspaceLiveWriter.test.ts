import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { checkLiveFolder, liveFileName, verifyLiveFile, writeLiveFile, type IntentJournal, type LiveIntent, type LiveDeps } from '../src/services/aiWorkspaces/liveFileWriter';
import { buildLiveStub, LIVE_FILE_MAX_BYTES } from '../src/services/aiWorkspaces/livePack';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '00000000-0000-4000-8000-000000000000';
const deps = { fs, path, crypto } as unknown as LiveDeps;
const fidOf = (p: string) => { const st = fs.statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; };
const sha = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex');

function memoryJournal(): IntentJournal & { map: Map<string, LiveIntent> } {
    const map = new Map<string, LiveIntent>();
    return { map, get: (d) => map.get(d) ?? null, set: (d, i) => { map.set(d, i); }, clear: (d) => { map.delete(d); }, all: () => [...map.entries()] };
}

let tmp: string;
let drive: string;
let vault: string;
const fileName = 'Pkm - live pack.md';
const target = () => ({ folder: drive, fileName, aioId: ID, generation: 1 });
const pack = (body: string) => `---\naio-live-pack: ${ID}\n---\n\n${body}\n`;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-live-')));
    drive = path.join(tmp, 'My Drive');
    vault = path.join(tmp, 'vault');
    fs.mkdirSync(drive);
    fs.mkdirSync(vault);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('live pack folder and name', () => {
    it('accepts an existing folder outside the vault and refuses the rest', async () => {
        expect((await checkLiveFolder(deps, drive, vault)).ok).toBe(true);
        expect(await checkLiveFolder(deps, '', vault)).toEqual({ ok: false, error: 'live-folder-missing' });
        expect(await checkLiveFolder(deps, 'relative', vault)).toEqual({ ok: false, error: 'mount-invalid' });
        expect(await checkLiveFolder(deps, path.join(tmp, 'nope'), vault)).toEqual({ ok: false, error: 'mount-missing' });
        expect(await checkLiveFolder(deps, path.join(vault), vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
        expect(await checkLiveFolder(deps, tmp, vault)).toEqual({ ok: false, error: 'mount-inside-vault' });
        expect(await checkLiveFolder(deps, drive, null)).toEqual({ ok: false, error: 'mount-vault-unverified' });
    });

    it('builds a safe file name from the project name', () => {
        expect(liveFileName('Pkm')).toEqual({ ok: true, value: 'Pkm - live pack.md' });
        expect(liveFileName('A/B: C?')).toEqual({ ok: true, value: 'A B C - live pack.md' });
        expect(liveFileName('...')).toEqual({ ok: false, error: 'live-name-invalid' });
    });
});

describe('writing the live file', () => {
    it('creates the file, then overwrites it in place (same inode) and verifies it', async () => {
        const j = memoryJournal();
        const first = await writeLiveFile(deps, j, target(), pack('one'), vault);
        expect(first.ok).toBe(true);
        const dest = path.join(drive, fileName);
        const inoBefore = fs.statSync(dest, { bigint: true }).ino;
        const second = await writeLiveFile(deps, j, target(), pack('two, which is longer than one'), vault);
        expect(second.ok).toBe(true);
        expect(fs.readFileSync(dest, 'utf8')).toBe(pack('two, which is longer than one'));
        expect(fs.statSync(dest, { bigint: true }).ino).toBe(inoBefore);
        const third = await writeLiveFile(deps, j, target(), pack('x'), vault);
        expect(fs.readFileSync(dest, 'utf8')).toBe(pack('x'));
        expect(j.map.size).toBe(0);
        expect(third.ok && third.value.fileSha).toBe(sha(pack('x')));
        expect(await verifyLiveFile(deps, j, target(), sha(pack('x')), vault)).toEqual({ ok: true, value: 'match' });
        fs.appendFileSync(dest, 'edited');
        expect(await verifyLiveFile(deps, j, target(), sha(pack('x')), vault)).toEqual({ ok: true, value: 'differs' });
        fs.unlinkSync(dest);
        expect(await verifyLiveFile(deps, j, target(), sha(pack('x')), vault)).toEqual({ ok: true, value: 'missing' });
    });

    it('never touches a file that is not this project\'s live pack', async () => {
        const dest = path.join(drive, fileName);
        fs.writeFileSync(dest, 'my own notes');
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        fs.writeFileSync(dest, buildLiveStub(fileName, OTHER, '2026-11-07T00:00:00Z'));
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(dest, 'utf8')).toContain(OTHER);
    });

    it('an unmarked file is ours only through an open intent for the same inode, never over a foreign marker', async () => {
        const dest = path.join(drive, fileName);
        fs.writeFileSync(dest, '');
        const st = fs.statSync(dest, { bigint: true });
        const j = memoryJournal();
        j.set(dest, { aioId: ID, fid: `${st.dev}:${st.ino + 1n}`, generation: 1, startedAt: 'x' });
        expect(await writeLiveFile(deps, j, target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        j.set(dest, { aioId: ID, fid: `${st.dev + 1n}:${st.ino}`, generation: 1, startedAt: 'x' });
        expect(await writeLiveFile(deps, j, target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        j.set(dest, { aioId: ID, fid: fidOf(dest), generation: 1, startedAt: 'x' });
        expect((await writeLiveFile(deps, j, target(), pack('one'), vault)).ok).toBe(true);
        fs.writeFileSync(dest, buildLiveStub(fileName, OTHER, 'x'));
        j.set(dest, { aioId: ID, fid: fidOf(dest), generation: 1, startedAt: 'x' });
        expect(await writeLiveFile(deps, j, target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
    });

    it('the marker counts only as a top-level frontmatter key', async () => {
        const dest = path.join(drive, fileName);
        fs.writeFileSync(dest, `---\ndescription: |\n  aio-live-pack: ${ID}\n---\nmine\n`);
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        fs.writeFileSync(dest, `# title\naio-live-pack: ${ID}\n`);
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
    });

    it('refuses a hard link (a second name of another file)', async () => {
        const protectedFile = path.join(vault, 'Protected.md');
        fs.writeFileSync(protectedFile, pack('protected words'));
        try { fs.linkSync(protectedFile, path.join(drive, fileName)); } catch { return; /* no hard links on this file system */ }
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(protectedFile, 'utf8')).toBe(pack('protected words'));
    });

    it('a file swapped while the authorization check runs is not truncated', async () => {
        const j = memoryJournal();
        await writeLiveFile(deps, j, target(), pack('one'), vault);
        const dest = path.join(drive, fileName);
        const swap = () => { fs.renameSync(dest, path.join(tmp, 'moved.md')); fs.writeFileSync(dest, 'someone else'); return true; };
        expect(await writeLiveFile(deps, j, target(), pack('two'), vault, swap)).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(dest, 'utf8')).toBe('someone else');
        expect(fs.readFileSync(path.join(tmp, 'moved.md'), 'utf8')).toBe(pack('one'));
    });

    it('refuses a symlink at the destination', async () => {
        const elsewhere = path.join(tmp, 'elsewhere.md');
        fs.writeFileSync(elsewhere, pack('old'));
        try { fs.symlinkSync(elsewhere, path.join(drive, fileName)); } catch { return; /* no symlink rights on this machine */ }
        expect(await writeLiveFile(deps, memoryJournal(), target(), pack('one'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(elsewhere, 'utf8')).toBe(pack('old'));
    });

    it('the last authorization check runs before anything is destroyed', async () => {
        const j = memoryJournal();
        await writeLiveFile(deps, j, target(), pack('one'), vault);
        expect(await writeLiveFile(deps, j, target(), pack('two'), vault, () => false)).toEqual({ ok: false, error: 'live-needs-review' });
        expect(fs.readFileSync(path.join(drive, fileName), 'utf8')).toBe(pack('one'));
        expect(j.map.size).toBe(0);
    });

    it('a failed write keeps the intent, closes the handle, and the next write of ours recovers', async () => {
        const j = memoryJournal();
        await writeLiveFile(deps, j, target(), pack('one'), vault);
        const dest = path.join(drive, fileName);
        let closed = 0;
        const failing = {
            ...deps,
            fs: { ...fs, promises: { ...fs.promises, open: async (p: string, flags: string) => {
                const h = await fs.promises.open(p, flags);
                return new Proxy(h, { get: (t, k) => {
                    if (k === 'write') return async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
                    if (k === 'close') return async () => { closed++; return t.close(); };
                    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
                } });
            } } },
        } as unknown as LiveDeps;
        expect(await writeLiveFile(failing, j, target(), pack('two'), vault)).toEqual({ ok: false, error: 'live-write-failed' });
        expect(closed).toBe(1);
        expect(fs.readFileSync(dest, 'utf8')).toBe('');
        expect(j.map.get(dest)?.fid).toBe(fidOf(dest));
        expect((await writeLiveFile(deps, j, target(), pack('three'), vault)).ok).toBe(true);
        expect(fs.readFileSync(dest, 'utf8')).toBe(pack('three'));
        expect(j.map.size).toBe(0);
    });

    it('a file swapped between the lstat and the open is refused', async () => {
        const j = memoryJournal();
        await writeLiveFile(deps, j, target(), pack('one'), vault);
        const dest = path.join(drive, fileName);
        const swapping = {
            ...deps,
            fs: { ...fs, promises: { ...fs.promises, open: async (p: string, flags: string) => {
                fs.unlinkSync(p);
                fs.writeFileSync(p, 'someone else');
                return fs.promises.open(p, flags);
            } } },
        } as unknown as LiveDeps;
        expect(await writeLiveFile(swapping, j, target(), pack('two'), vault)).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(dest, 'utf8')).toBe('someone else');
    });

    it('reads are bounded and an oversized file is damaged, not loaded', async () => {
        const j = memoryJournal();
        await writeLiveFile(deps, j, target(), pack('one'), vault);
        const dest = path.join(drive, fileName);
        fs.appendFileSync(dest, 'x'.repeat(LIVE_FILE_MAX_BYTES + 100));
        expect(await verifyLiveFile(deps, j, target(), sha(pack('one')), vault)).toEqual({ ok: true, value: 'differs' });
        expect(await writeLiveFile(deps, j, target(), 'x'.repeat(LIVE_FILE_MAX_BYTES + 1), vault)).toEqual({ ok: false, error: 'pack-over-budget' });
    });
});
