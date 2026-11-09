/**
 * The importer's only contact with the source folder outside the vault: list it and read files from it. READ ONLY: nothing
 * in this module writes, renames, moves or deletes anything there (the originals in Drive are never touched).
 *
 * Safe-open contract for every read: the path's `lstat` must be a regular file; it is opened read-only (with O_NOFOLLOW where
 * the platform has it); the handle's `fstat` must be the SAME file (dev:ino), a single link, with the size and modified time
 * the listing saw; at most cap + 1 bytes are read; the handle is checked again after the read; it is closed in a finally.
 * Windows has no no-follow open: there, the identity comparison is the guard, and a swapped entry fails it (closed).
 *
 * Desktop only: the Node modules come from `nodeDeps()`; on mobile there are none and nothing here runs.
 */
import { Result, ok, err } from '../../core/result';
import type { NodeDeps } from '../offload/fingerprint';
import { isImportableName, isTextCandidate, MAX_ENTRIES } from './importPolicy';

export interface ListedFile {
    name: string;
    /** Absolute path inside the resolved source folder */
    path: string;
    /** "dev:ino" (decimal strings: Windows file ids exceed 2^53) */
    fid: string;
    size: number;
    mtimeMs: number;
}

export interface Listing {
    /** Text files with a usable name */
    candidates: ListedFile[];
    /** Text files whose name cannot be used (refused, never opened) */
    unsafe: ListedFile[];
    /** Other files (not .md or .txt): counted only */
    other: number;
}

type BigStats = import('fs').BigIntStats;
const identityOf = (s: BigStats): string => `${s.dev.toString()}:${s.ino.toString()}`;

function inside(deps: NodeDeps, root: string, target: string): boolean {
    const fold = (p: string): string => (deps.path.sep === '\\' ? p.toLowerCase() : p);
    const rel = deps.path.relative(fold(root), fold(target));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${deps.path.sep}`) && !deps.path.isAbsolute(rel);
}

/** Every entry at the top level of the (already resolved) folder. More than MAX_ENTRIES refuses the whole listing. */
export async function listSource(deps: NodeDeps, root: string): Promise<Result<Listing>> {
    let names: string[];
    try {
        names = await deps.fs.promises.readdir(root);
    } catch {
        return err('claude-import-source-missing');
    }
    if (names.length > MAX_ENTRIES) return err('claude-import-folder-too-big');
    const out: Listing = { candidates: [], unsafe: [], other: 0 };
    for (const name of names) {
        const path = deps.path.join(root, name);
        if (!inside(deps, root, path)) continue;
        let st: BigStats;
        try {
            st = await deps.fs.promises.lstat(path, { bigint: true });
        } catch {
            continue; // gone since the listing: it is simply not there this run
        }
        // A link is never a candidate, whatever it points at; folders are not looked into.
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (!isTextCandidate(name)) {
            if (!name.startsWith('.')) out.other++;
            continue;
        }
        const file: ListedFile = { name, path, fid: identityOf(st), size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
        (isImportableName(name) ? out.candidates : out.unsafe).push(file);
    }
    out.candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out.unsafe.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return ok(out);
}

export type ReadOutcome =
    | { kind: 'read'; bytes: Uint8Array; sha256: string }
    | { kind: 'too-large' }
    /** The file is not the one listed, or changed during the read: it waits for a later run */
    | { kind: 'changed' }
    /** No answer within the deadline (an online-only Drive file can stall): it waits */
    | { kind: 'timeout' }
    | { kind: 'failed' };

/** How long one read may take before the file is left for a later run. */
export const READ_DEADLINE_MS = 20_000;

type Handle = Awaited<ReturnType<typeof import('fs').promises.open>>;

async function readAtMost(handle: Handle, limit: number): Promise<{ bytes: Uint8Array; over: boolean }> {
    const buf = new Uint8Array(limit + 1);
    let filled = 0;
    while (filled < buf.length) {
        const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
    }
    return { bytes: buf.slice(0, Math.min(filled, limit)), over: filled > limit };
}

async function readUnsafe(deps: NodeDeps, root: string, file: ListedFile, cap: number): Promise<ReadOutcome> {
    if (!inside(deps, root, file.path)) return { kind: 'changed' };
    let st: BigStats;
    try {
        st = await deps.fs.promises.lstat(file.path, { bigint: true });
    } catch {
        return { kind: 'changed' };
    }
    if (st.isSymbolicLink() || !st.isFile() || identityOf(st) !== file.fid || Number(st.size) !== file.size || Number(st.mtimeMs) !== file.mtimeMs) return { kind: 'changed' };
    if (file.size > cap) return { kind: 'too-large' };
    const c = deps.fs.constants;
    const flags: number | string = typeof c?.O_NOFOLLOW === 'number' ? c.O_RDONLY | c.O_NOFOLLOW : 'r';
    let handle: Handle;
    try {
        handle = await deps.fs.promises.open(file.path, flags);
    } catch {
        return { kind: 'failed' };
    }
    try {
        const same = (s: BigStats): boolean => s.isFile() && s.nlink === 1n && identityOf(s) === file.fid && Number(s.size) === file.size && Number(s.mtimeMs) === file.mtimeMs;
        if (!same(await handle.stat({ bigint: true }))) return { kind: 'changed' };
        const { bytes, over } = await readAtMost(handle, cap);
        if (over) return { kind: 'too-large' };
        if (!same(await handle.stat({ bigint: true })) || bytes.length !== file.size) return { kind: 'changed' };
        return { kind: 'read', bytes, sha256: deps.crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch {
        return { kind: 'failed' };
    } finally {
        await handle.close().catch(() => undefined);
    }
}

/** One bounded, identity-checked read with a deadline. A late answer is ignored (the read settles and closes on its own). */
export async function readBounded(deps: NodeDeps, root: string, file: ListedFile, cap: number, deadlineMs: number = READ_DEADLINE_MS): Promise<ReadOutcome> {
    let timer: number | undefined;
    const late = new Promise<ReadOutcome>((resolve) => { timer = window.setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs); });
    try {
        return await Promise.race([readUnsafe(deps, root, file, cap).catch((): ReadOutcome => ({ kind: 'failed' })), late]);
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
    }
}
