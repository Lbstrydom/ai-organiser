/**
 * The import run against a fake source folder (Node fs shape) and a fake vault. Proves: the two sample files import on a
 * manual run, nothing imports twice, bytes are copied exactly, refusals are reported once, the write-ahead record recovers
 * an interrupted run without a duplicate, an identity swap fails closed, the read scheduler is fair, a stopped run writes
 * nothing more, and the source folder is never written to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as nodePath from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { ok, err, type Result } from '../src/core/result';
import { emptyLedger, type ImportLedger } from '../src/services/claudeImport/importLedger';
import { resolveAmbiguous, runImport, type ImportEnv } from '../src/services/claudeImport/importService';
import { outstandingReads } from '../src/services/claudeImport/sourceFolder';
import type { ImportVaultPort } from '../src/services/claudeImport/importWriter';
import type { LedgerPort } from '../src/services/claudeImport/ledgerStore';
import type { NodeDeps } from '../src/services/offload/fingerprint';

vi.stubGlobal('window', globalThis);

const ROOT = '/drive/My Drive/Apps/AI Organiser/From Claude';
const VAULT = '/vault';
const DEST = '0 Inbox/From Claude';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => nodeCrypto.createHash('sha256').update(b).digest('hex');

interface FakeFile { bytes: Uint8Array; mtimeMs: number; ino: number; symlink?: boolean; nlink?: number; hang?: boolean; fail?: boolean }

const READ_METHODS = new Set(['realpath', 'stat', 'readdir', 'lstat', 'open']);

class FakeSource {
    files = new Map<string, FakeFile>();
    extraNames: string[] = [];
    opens: string[] = [];
    /** Every open's flags: the source must only ever be opened for reading */
    openFlags: Array<number | string> = [];
    touched = new Set<string>();
    nextIno = 100;
    /** A hanging read waits for this; a test releases it so nothing is left running */
    unhang: () => void = () => undefined;
    private hangGate = new Promise<void>((r) => { this.unhang = r; });
    /** lstat errors by name (other than ENOENT) */
    lstatErrors = new Map<string, string>();
    /** Called just before open: lets a test put a different file at the path between the listing and the open */
    beforeOpen?: (name: string) => void;
    /** Called after a handle's first fstat: lets a test change the opened file during the read */
    onOpen?: (name: string) => void;

    put(name: string, text: string | Uint8Array, mtimeMs = 1_000, extra: Partial<FakeFile> = {}): void {
        const bytes = typeof text === 'string' ? enc(text) : text;
        const prev = this.files.get(name);
        this.files.set(name, { bytes, mtimeMs, ino: prev?.ino ?? this.nextIno++, ...extra });
    }

    private stats(f: FakeFile, link = false) {
        return {
            isSymbolicLink: () => link, isFile: () => !link, isDirectory: () => false,
            dev: 1n, ino: BigInt(f.ino), size: BigInt(f.bytes.length), mtimeMs: BigInt(f.mtimeMs), nlink: BigInt(f.nlink ?? 1),
        };
    }

    deps(): NodeDeps {
        const name = (p: string): string => nodePath.posix.basename(p);
        const impl = {
            realpath: async (p: string) => p,
            stat: async (p: string) => {
                if (p === ROOT || p === VAULT) return { isDirectory: () => true };
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            },
            readdir: async (p: string) => {
                if (p !== ROOT) throw new Error('ENOENT');
                return [...this.files.keys(), ...this.extraNames];
            },
            lstat: async (p: string) => {
                const code = this.lstatErrors.get(name(p));
                if (code) throw Object.assign(new Error(code), { code });
                const f = this.files.get(name(p));
                if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return this.stats(f, f.symlink === true);
            },
            open: async (p: string, flags: number | string) => {
                const n = name(p);
                this.opens.push(n);
                this.openFlags.push(flags);
                this.beforeOpen?.(n);
                // The handle is bound to the file that is at the path NOW, as a real descriptor is.
                const f0 = this.files.get(n);
                if (!f0) throw new Error('ENOENT');
                if (f0.fail) throw new Error('EIO');
                let first = true;
                return {
                    stat: async () => {
                        const f = f0;
                        // The handle points at what was opened: a symlink resolves to some other file (another identity).
                        const s = this.stats(f.symlink ? { ...f, ino: f.ino + 10_000 } : f);
                        if (first) { first = false; this.onOpen?.(n); }
                        return s;
                    },
                    read: async (buf: Uint8Array, off: number, len: number, pos: number) => {
                        const f = f0;
                        if (f.hang) await this.hangGate;
                        const chunk = f.bytes.subarray(pos, pos + len);
                        buf.set(chunk, off);
                        return { bytesRead: chunk.length };
                    },
                    close: async () => undefined,
                };
            },
        };
        const promises = new Proxy(impl, {
            get: (t, prop: string) => {
                this.touched.add(prop);
                if (!READ_METHODS.has(prop)) throw new Error(`source fs: ${prop} is not allowed`);
                return (t as Record<string, unknown>)[prop];
            },
        });
        return { fs: { promises, constants: { O_RDONLY: 0 } }, path: nodePath.posix, crypto: nodeCrypto } as unknown as NodeDeps;
    }
}

class FakeVault implements ImportVaultPort {
    files = new Map<string, Uint8Array>();
    folders = new Set<string>();
    created: string[] = [];
    corruptReadBack = false;
    async fileBytes(path: string) {
        if (this.folders.has(path)) return 'other' as const;
        const b = this.files.get(path);
        if (!b) return 'none' as const;
        return this.corruptReadBack && this.created.includes(path) ? enc('changed') : b;
    }
    async ensureFolder(folder: string): Promise<Result<void>> { this.folders.add(folder); return ok(undefined); }
    async createBinary(path: string, bytes: Uint8Array): Promise<Result<void>> {
        if (this.files.has(path)) return err('exists');
        this.files.set(path, bytes.slice());
        this.created.push(path);
        return ok(undefined);
    }
}

class FakeLedger implements LedgerPort {
    ledger: ImportLedger = emptyLedger();
    saves = 0;
    failOnSave: number[] = [];
    get() { return this.ledger; }
    async save(next: ImportLedger): Promise<Result<void>> {
        this.saves++;
        if (this.failOnSave.includes(this.saves)) return err('claude-import-ledger-unsaved');
        this.ledger = JSON.parse(JSON.stringify(next)) as ImportLedger;
        return ok(undefined);
    }
}

let src: FakeSource;
let vault: FakeVault;
let ledger: FakeLedger;
let clock: number;
let alive: () => boolean;

const env = (over: Partial<ImportEnv> = {}): ImportEnv => ({
    deps: src.deps(),
    vaultBase: VAULT,
    notes: vault,
    ledger,
    settings: { sourceFolder: ROOT, destination: DEST, maxKB: 512, stabilitySeconds: 30 },
    isProtected: () => false,
    route: (text) => (text.includes('## Handoff') ? { kind: 'no-id' } : { kind: 'not-handback' }),
    now: () => clock,
    alive: () => alive(),
    ...over,
});

beforeEach(() => {
    src = new FakeSource();
    vault = new FakeVault();
    ledger = new FakeLedger();
    clock = 10_000_000;
    alive = () => true;
});

const run = async (trigger: 'manual' | 'background' = 'manual', over: Partial<ImportEnv> = {}) => {
    const r = await runImport(env(over), trigger);
    if (!r.ok) throw new Error(r.error);
    return r.value;
};

describe('claude import run', () => {
    it('imports the two sample files on a manual run, byte for byte, and nothing on the next run', async () => {
        src.put('From Claude test - 2026-11-09.md', '# Test from Claude\n\nHello vault.\n');
        src.put('From Claude phone test.md', '# Phone\n\n## Handoff\nProject ID: x\n');
        const first = await run();
        expect(first.imported.map((i) => i.path).sort()).toEqual([`${DEST}/From Claude phone test.md`, `${DEST}/From Claude test - 2026-11-09.md`]);
        expect(first.imported.find((i) => i.name === 'From Claude phone test.md')?.route.kind).toBe('no-id');
        expect(vault.files.get(`${DEST}/From Claude test - 2026-11-09.md`)).toEqual(src.files.get('From Claude test - 2026-11-09.md')?.bytes);
        expect(Object.keys(ledger.ledger.imported)).toHaveLength(2);
        expect(Object.keys(ledger.ledger.pending)).toHaveLength(0);
        clock += 60_000;
        const second = await run();
        expect(second.imported).toEqual([]);
        expect(second.alreadyImported).toBe(2);
        expect(vault.created).toHaveLength(2);
    });

    it('never touches the source folder with anything but reads', async () => {
        src.put('a.md', 'A');
        await run();
        expect([...src.touched].every((m) => READ_METHODS.has(m))).toBe(true);
        // Read-only opens only: 'r', or O_RDONLY (0 here) with no write, create, truncate or append bits.
        expect(src.openFlags.length).toBeGreaterThan(0);
        expect(src.openFlags.every((f) => f === 'r' || f === 0)).toBe(true);
    });

    it('keeps a BOM, CRLF and non-ASCII bytes exactly', async () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Café\r\nlíne two\r\n')]);
        src.put('bom.txt', bytes);
        await run();
        expect(vault.files.get(`${DEST}/bom.md`)).toEqual(bytes);
    });

    it('does not trust an old modified time in the background: a second look after the window imports', async () => {
        src.put('a.md', 'A', 1_000);
        expect((await run('background')).imported).toHaveLength(0);
        clock += 31_000;
        expect((await run('background')).imported).toHaveLength(1);
    });

    it('imports the same content under a new name only once, and an edited file under the hash-suffixed name', async () => {
        src.put('a.md', 'same');
        await run();
        src.put('copy of a.md', 'same');
        clock += 60_000;
        expect((await run()).imported).toEqual([]);
        src.put('a.md', 'edited and longer', 2_000);
        clock += 60_000;
        const r = await run();
        expect(r.imported.map((i) => i.path)).toEqual([`${DEST}/a-${sha(enc('edited and longer')).slice(0, 8)}.md`]);
        expect(vault.files.get(`${DEST}/a.md`)).toEqual(enc('same'));
    });

    it('finds an edit that kept the size and modified time on the next manual run', async () => {
        src.put('a.md', 'aaaa');
        await run();
        const f = src.files.get('a.md') as FakeFile;
        f.bytes = enc('bbbb');
        clock += 60_000;
        expect((await run()).imported).toHaveLength(1);
    });

    it('refuses an oversized file without opening it, and reports a refusal once while still listing it', async () => {
        src.put('big.md', 'x'.repeat(600 * 1024));
        src.put('dv.md', '```dataviewjs\ndv.paragraph(1)\n```');
        src.put('CON.md', 'reserved name');
        const first = await run();
        expect(src.opens).not.toContain('big.md');
        expect(src.opens).not.toContain('CON.md');
        expect(first.outstanding.map((r) => `${r.name}:${r.reason}`).sort()).toEqual(['CON.md:unsupported-name', 'big.md:too-large', 'dv.md:active-content']);
        expect(first.newRefusals).toHaveLength(3);
        clock += 60_000;
        const second = await run('background');
        expect(second.newRefusals).toEqual([]);
        expect(second.outstanding).toHaveLength(3);
        // A higher limit judges the large file again.
        clock += 60_000;
        const third = await run('manual', { settings: { sourceFolder: ROOT, destination: DEST, maxKB: 1024, stabilitySeconds: 30 } });
        expect(third.imported.map((i) => i.name)).toEqual(['big.md']);
    });

    it('stops and says so when the vault folder refuses new notes, without retrying every file', async () => {
        src.put('a.md', 'A');
        src.put('b.md', 'B');
        vault.createBinary = async () => err('claude-import-copy-failed');
        const r = await run();
        expect(r.stoppedBy).toBe('claude-import-copy-failed');
        expect(Object.keys(ledger.ledger.pending)).toEqual([]);
        expect(Object.keys(ledger.ledger.imported)).toEqual([]);
    });

    it('keeps the intent when the name is taken in between, and the next run reconciles it', async () => {
        src.put('a.md', 'A');
        const real = vault.createBinary.bind(vault);
        vault.createBinary = async (path: string) => { vault.files.set(path, enc('A')); return err('exists'); };
        const r = await run();
        expect(r.imported).toEqual([]);
        expect(Object.keys(ledger.ledger.pending)).toHaveLength(1);
        vault.createBinary = real;
        clock += 60_000;
        await run();
        expect(Object.keys(ledger.ledger.imported)).toHaveLength(1);
        expect(Object.keys(ledger.ledger.pending)).toHaveLength(0);
    });

    it('creates nothing when the write-ahead record cannot be saved', async () => {
        src.put('a.md', 'A');
        ledger.failOnSave = [1];
        const r = await run();
        expect(r.stoppedBy).toBe('claude-import-ledger-unsaved');
        expect(vault.created).toEqual([]);
    });

    it('recovers a copy made before its record was saved, without a second copy', async () => {
        src.put('a.md', 'A');
        ledger.failOnSave = [2, 3]; // the pending save works; the "imported" save and the end-of-run save fail
        const r = await run();
        expect(r.stoppedBy).toBe('claude-import-ledger-unsaved');
        expect(vault.created).toEqual([`${DEST}/a.md`]);
        expect(Object.keys(ledger.ledger.pending)).toHaveLength(1);
        clock += 60_000;
        const next = await run();
        expect(next.imported).toEqual([]);
        expect(vault.created).toHaveLength(1);
        expect(Object.keys(ledger.ledger.imported)).toHaveLength(1);
        expect(Object.keys(ledger.ledger.pending)).toHaveLength(0);
    });

    it('leaves an ambiguous copy to the person: neither imported again nor marked imported until they choose', async () => {
        src.put('a.md', 'A');
        const hash = sha(enc('A'));
        ledger.ledger.pending[hash] = { name: 'a.md', path: `${DEST}/a.md`, at: 'x' };
        vault.files.set(`${DEST}/a.md`, enc('an unrelated note'));
        const r = await run();
        expect(r.ambiguous).toEqual([{ hash, name: 'a.md', path: `${DEST}/a.md` }]);
        expect(r.imported).toEqual([]);
        expect(vault.created).toEqual([]);
        expect((await resolveAmbiguous(ledger, hash, 'fresh-copy', 'now')).ok).toBe(true);
        clock += 60_000;
        const again = await run();
        expect(again.imported.map((i) => i.path)).toEqual([`${DEST}/a-${hash.slice(0, 8)}.md`]);
        expect(vault.files.get(`${DEST}/a.md`)).toEqual(enc('an unrelated note'));
    });

    it('records "it is the import" as an unverified import', async () => {
        const hash = sha(enc('A'));
        ledger.ledger.pending[hash] = { name: 'a.md', path: `${DEST}/a.md`, at: 'x', ambiguous: true };
        await resolveAmbiguous(ledger, hash, 'is-import', 'now');
        expect(ledger.ledger.imported[hash]).toEqual({ name: 'a.md', path: `${DEST}/a.md`, at: 'now', verified: false });
    });

    it('records a copy that does not read back the same as unverified, and never deletes or retries it', async () => {
        src.put('a.md', 'A');
        vault.corruptReadBack = true;
        const r = await run();
        expect(r.imported[0].verified).toBe(false);
        clock += 60_000;
        expect((await run()).imported).toEqual([]);
        expect(vault.created).toHaveLength(1);
    });

    it('fails closed when the entry is swapped for a link or for another file during the read', async () => {
        src.put('a.md', 'AAAA');
        // A different file (same size) is put at the path between the listing and the open.
        src.beforeOpen = (n) => { const f = src.files.get(n) as FakeFile; src.files.set(n, { ...f, ino: 999 }); };
        expect((await run()).imported).toEqual([]);
        src.beforeOpen = undefined;
        src.put('b.md', 'B', 1_000, { symlink: true });
        clock += 60_000;
        const r = await run();
        expect(r.imported.map((i) => i.name)).toEqual(['a.md']);
        expect(src.opens).not.toContain('b.md');
    });

    it('waits for a file that changes while it is read', async () => {
        src.put('a.md', 'AAAA');
        src.onOpen = (n) => { const f = src.files.get(n) as FakeFile; f.mtimeMs += 1; };
        const r = await run();
        expect(r.imported).toEqual([]);
        expect(r.waiting).toBe(1);
    });

    it('reaches every file within ceil(N / limit) manual runs, even behind failing reads and imported files', async () => {
        for (let i = 0; i < 50; i++) src.put(`old-${String(i).padStart(3, '0')}.md`, `old ${i}`, 10);
        await run('manual', { maxReads: 50 });
        for (let i = 0; i < 10; i++) src.put(`bad-${i}.md`, `bad ${i}`, 1, { fail: true });
        for (let i = 0; i < 60; i++) src.put(`new-${String(i).padStart(3, '0')}.md`, `new ${i}`, 20);
        let imported = 0;
        for (let k = 0; k < 3; k++) {
            clock += 60_000;
            imported += (await run('manual', { maxReads: 50 })).imported.length;
        }
        expect(imported).toBe(60);
    });

    it('stops writing once the run is no longer alive', async () => {
        src.put('a.md', 'A');
        src.put('b.md', 'B');
        let checks = 0;
        alive = () => ++checks < 2;
        const r = await run();
        expect(r.cancelled).toBe(true);
        expect(vault.created).toEqual([]);
        expect(Object.keys(ledger.ledger.imported)).toHaveLength(0);
    });

    it('leaves a stalled read for a later run and starts no other read in that run', async () => {
        src.put('a.md', 'A', 1_000, { hang: true });
        src.put('b.md', 'B', 2_000);
        const r = await run('manual', { readDeadlineMs: 20 });
        expect(r.imported).toEqual([]);
        expect(r.waiting).toBe(2);
        expect(src.opens).toEqual(['a.md']);
        // The next run tries the other file first (least recently attempted goes first).
        clock += 60_000;
        const next = await run('manual', { readDeadlineMs: 20, maxReads: 2 });
        expect(next.imported.map((i) => i.name)).toEqual(['b.md']);
        // The stalled read is still running: the same file is not opened again while it is.
        expect(src.opens.filter((n) => n === 'a.md')).toHaveLength(1);
        expect(outstandingReads()).toBe(1);
        src.unhang();
        await vi.waitFor(() => expect(outstandingReads()).toBe(0));
    });

    it('lets a file it could not inspect wait, keeping what it knew about it', async () => {
        src.put('a.md', 'A');
        src.put('big.md', 'x'.repeat(600 * 1024));
        await run();
        src.lstatErrors.set('big.md', 'EACCES');
        clock += 60_000;
        const r = await run();
        expect(r.waiting).toBe(1);
        expect(ledger.ledger.refused['big.md']?.reason).toBe('too-large');
        expect(ledger.ledger.seen['big.md']).toBeDefined();
    });

    it('refuses the whole run for an oversized folder, a missing source or a protected destination', async () => {
        src.extraNames = Array.from({ length: 5001 }, (_, i) => `x${i}.bin`);
        expect(await runImport(env(), 'manual')).toEqual({ ok: false, error: 'claude-import-folder-too-big' });
        expect(await runImport(env({ settings: { sourceFolder: '/nowhere', destination: DEST, maxKB: 512, stabilitySeconds: 30 } }), 'manual')).toEqual({ ok: false, error: 'claude-import-source-missing' });
        expect(await runImport(env({ isProtected: (p) => p.startsWith('0 Inbox') }), 'manual')).toEqual({ ok: false, error: 'claude-import-destination-protected' });
        expect(await runImport(env({ vaultBase: null }), 'manual')).toEqual({ ok: false, error: 'claude-import-source-invalid' });
    });

    it('drops observations of files that are no longer in the folder after a complete listing', async () => {
        src.put('a.md', 'A');
        src.put('big.md', 'x'.repeat(600 * 1024));
        await run();
        src.files.delete('big.md');
        clock += 60_000;
        await run();
        expect(Object.keys(ledger.ledger.seen)).toEqual(['a.md']);
        expect(ledger.ledger.refused).toEqual({});
    });
});
