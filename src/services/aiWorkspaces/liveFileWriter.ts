/**
 * The one place the live pack touches a file outside the vault: a folder inside Google Drive for desktop.
 *
 *  - The folder is checked like the offload's mount folder: absolute, an existing directory, not the vault, not inside or around it.
 *  - The file is overwritten IN PLACE (same inode), because that is what keeps its Drive file id: rename-over is not proven to.
 *  - Every check and the write go through ONE handle: lstat, open, fstat identity, the ownership marker, an intent record, truncate,
 *    write, sync, bounded read-back, close in a finally. A file that is not this project's live pack is never touched.
 *  - Reads are bounded: at most LIVE_FILE_MAX_BYTES + 1 bytes, whatever the file says its size is.
 *
 * Desktop only: Node modules come from `desktopRequire`; on mobile `liveDeps()` is null and nothing here runs.
 */
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import { checkMountFolder, isSafeFileName } from '../offload/localMount';
import { nodeDeps, type NodeDeps } from '../offload/fingerprint';
import { hasAnyLiveMarker, hasLiveMarker, LIVE_FILE_MAX_BYTES } from './livePack';
import { LIVE_FILE_SUFFIX } from './workspaceRecord';

export type LiveDeps = NodeDeps;

/** Node modules, or null on mobile. */
export function liveDeps(): LiveDeps | null {
    return nodeDeps();
}

/** A write in progress, recorded before the file is truncated; device-local, never synced. */
export interface LiveIntent {
    aioId: string;
    /** Device and file id ("dev:ino", decimal) of the file the intent was recorded for */
    fid: string;
    generation: number;
    startedAt: string;
}

export interface IntentJournal {
    get(dest: string): LiveIntent | null;
    set(dest: string, intent: LiveIntent): void;
    clear(dest: string): void;
    all(): Array<[string, LiveIntent]>;
}

export interface LiveTarget {
    /** The approved canonical folder */
    folder: string;
    fileName: string;
    aioId: string;
    generation: number;
}

const HEAD_BYTES = 2048;

/** "<project> - live pack.md" from a project name, or `live-name-invalid`. */
export function liveFileName(projectName: string): Result<string> {
    const cleaned = [...projectName].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch)).join('')
        .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120).trim();
    const name = `${cleaned}${LIVE_FILE_SUFFIX}`;
    return cleaned !== '' && isSafeFileName(name) ? ok(name) : err('live-name-invalid');
}

/** The folder checked and resolved (realpath). Codes are the offload's: mount-invalid, mount-missing, mount-inside-vault, mount-vault-unverified. */
export async function checkLiveFolder(deps: LiveDeps, raw: string, vaultBase: string | null): Promise<Result<string>> {
    if (raw.trim() === '') return err('live-folder-missing');
    // Without a vault path the "not inside the vault" question stays open: the answer is no.
    if (!vaultBase) return err('mount-vault-unverified');
    return checkMountFolder(deps, raw, vaultBase);
}

/** SHA-256 hex of bytes. */
function sha256Hex(deps: LiveDeps, bytes: Uint8Array): string {
    return deps.crypto.createHash('sha256').update(bytes).digest('hex');
}

type Handle = Awaited<ReturnType<typeof import('fs').promises.open>>;

/** Read from position 0 through the handle, at most `limit + 1` bytes: one byte over means "too big". */
async function boundedRead(handle: Handle, limit: number): Promise<{ bytes: Uint8Array; over: boolean }> {
    const buf = new Uint8Array(limit + 1);
    let filled = 0;
    while (filled < buf.length) {
        const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
    }
    return { bytes: buf.subarray(0, Math.min(filled, limit)), over: filled > limit };
}

async function writeAll(handle: Handle, bytes: Uint8Array): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
        if (bytesWritten <= 0) throw new Error('short write');
        written += bytesWritten;
    }
}

const decoder = new TextDecoder();

function inside(deps: LiveDeps, root: string, target: string): boolean {
    const fold = (p: string): string => (deps.path.sep === '\\' ? p.toLowerCase() : p);
    const rel = deps.path.relative(fold(root), fold(target));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${deps.path.sep}`) && !deps.path.isAbsolute(rel);
}

/** The destination inside the approved folder, re-checked now (the drive may be gone, the folder may have moved). */
async function destinationOf(deps: LiveDeps, target: LiveTarget, vaultBase: string | null): Promise<Result<{ root: string; dest: string }>> {
    const root = await checkLiveFolder(deps, target.folder, vaultBase);
    if (!root.ok) return err(root.error);
    if (!isSafeFileName(target.fileName)) return err('live-name-invalid');
    const dest = deps.path.join(root.value, target.fileName);
    if (!inside(deps, root.value, dest)) return err('live-name-invalid');
    return ok({ root: root.value, dest });
}

/** A file's identity: device and file id together, as decimal strings (Windows file ids exceed 2^53, so a number would lose digits). */
const identityOf = (s: import('fs').BigIntStats): string => `${s.dev.toString()}:${s.ino.toString()}`;

/** True when the path names exactly this regular file now: not a link, one name only (no hard-link alias), inside the folder. */
async function stillNamed(deps: LiveDeps, root: string, dest: string, fid: string): Promise<boolean> {
    try {
        const st = await deps.fs.promises.lstat(dest, { bigint: true });
        if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1n || identityOf(st) !== fid) return false;
        return inside(deps, root, await deps.fs.promises.realpath(dest));
    } catch {
        return false;
    }
}

/** Open an existing destination and prove, through the handle, that it is the regular file the path named. */
async function openExisting(deps: LiveDeps, root: string, dest: string): Promise<Result<{ handle: Handle; fid: string } | null>> {
    let st: import('fs').BigIntStats;
    try {
        st = await deps.fs.promises.lstat(dest, { bigint: true });
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok(null) : err('live-write-failed');
    }
    // A link, or a second name of another file (a hard link could alias a protected one): never ours to write through.
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1n) return err('live-file-not-ours');
    const handle = await deps.fs.promises.open(dest, 'r+');
    try {
        const hs = await handle.stat({ bigint: true });
        // Replaced between the lstat and the open: not the file we checked.
        if (!hs.isFile() || identityOf(hs) !== identityOf(st) || !(await stillNamed(deps, root, dest, identityOf(hs)))) { await handle.close(); return err('live-file-not-ours'); }
        return ok({ handle, fid: identityOf(hs) });
    } catch (e) {
        await handle.close().catch(() => undefined);
        throw e;
    }
}

/** Ours = this project's marker, or no marker at all with an open intent of ours for this exact path and file identity. */
function owned(head: string, target: LiveTarget, intent: LiveIntent | null, fid: string): boolean {
    if (hasLiveMarker(head, target.aioId)) return true;
    if (hasAnyLiveMarker(head)) return false;
    return intent !== null && intent.aioId === target.aioId.toLowerCase() && intent.fid === fid;
}

export interface WriteOutcome {
    fileSha: string;
    /** Device and file id of the written file */
    fid: string;
}

/**
 * Write `text` as the live file. `beforeDestroy` runs after every check and immediately before the file is truncated or created:
 * the caller's last authorization check (a false answer writes nothing). The folder and the file's identity are checked again after
 * it, because the file system may have changed while it ran, and once more after the write.
 */
export async function writeLiveFile(
    deps: LiveDeps,
    intents: IntentJournal,
    target: LiveTarget,
    text: string,
    vaultBase: string | null,
    beforeDestroy: () => Promise<boolean> | boolean = () => true,
): Promise<Result<WriteOutcome>> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > LIVE_FILE_MAX_BYTES) return err('pack-over-budget');
    let handle: Handle | null = null;
    try {
        const where = await destinationOf(deps, target, vaultBase);
        if (!where.ok) return err(where.error);
        const { root, dest } = where.value;
        const existing = await openExisting(deps, root, dest);
        if (!existing.ok) return err(existing.error);
        let fid: string;
        const intent = (id: string): LiveIntent => ({ aioId: target.aioId.toLowerCase(), fid: id, generation: target.generation, startedAt: new Date().toISOString() });
        if (existing.value) {
            handle = existing.value.handle;
            fid = existing.value.fid;
            const head = decoder.decode((await boundedRead(handle, HEAD_BYTES)).bytes);
            if (!owned(head, target, intents.get(dest), fid)) return err('live-file-not-ours');
            if (!(await beforeDestroy())) return err('live-needs-review');
            const again = await destinationOf(deps, target, vaultBase);
            if (!again.ok) return err(again.error);
            if (again.value.dest !== dest || !(await stillNamed(deps, root, dest, fid))) return err('live-file-not-ours');
            // The content may have changed in place while the check ran: ownership is read again, through the same handle.
            const headNow = decoder.decode((await boundedRead(handle, HEAD_BYTES)).bytes);
            if (!owned(headNow, target, intents.get(dest), fid)) return err('live-file-not-ours');
            intents.set(dest, intent(fid));
            await handle.truncate(0);
        } else {
            if (!(await beforeDestroy())) return err('live-needs-review');
            const again = await destinationOf(deps, target, vaultBase);
            if (!again.ok) return err(again.error);
            if (again.value.dest !== dest) return err('live-file-not-ours');
            // Exclusive read/write: fails if a file appeared meanwhile.
            handle = await deps.fs.promises.open(dest, 'wx+');
            fid = identityOf(await handle.stat({ bigint: true }));
            if (!(await stillNamed(deps, root, dest, fid))) return err('live-file-not-ours');
            intents.set(dest, intent(fid));
        }
        await writeAll(handle, bytes);
        await handle.sync();
        const back = await boundedRead(handle, LIVE_FILE_MAX_BYTES);
        const fileSha = sha256Hex(deps, bytes);
        if (back.over || sha256Hex(deps, back.bytes) !== fileSha) return err('live-write-failed');
        // What we wrote must still be the file the path names (the intent stays when it is not).
        if (!(await stillNamed(deps, root, dest, fid))) return err('live-write-failed');
        intents.clear(dest);
        return ok({ fileSha, fid });
    } catch (e) {
        logger.warn('AiWorkspaces', 'Could not write the live pack file', e);
        return err('live-write-failed');
    } finally {
        if (handle) await handle.close().catch((e: unknown) => logger.warn('AiWorkspaces', 'Could not close the live pack file', e));
    }
}

export type VerifyOutcome = 'match' | 'missing' | 'differs';

/** Is the file there, ours, and exactly what was last written? Reads at most LIVE_FILE_MAX_BYTES + 1 bytes; writes nothing. */
export async function verifyLiveFile(deps: LiveDeps, intents: IntentJournal, target: LiveTarget, expectedSha: string, vaultBase: string | null): Promise<Result<VerifyOutcome>> {
    let handle: Handle | null = null;
    try {
        const where = await destinationOf(deps, target, vaultBase);
        if (!where.ok) return err(where.error);
        const existing = await openExisting(deps, where.value.root, where.value.dest);
        if (!existing.ok) return err(existing.error);
        if (!existing.value) return ok('missing');
        handle = existing.value.handle;
        const { bytes, over } = await boundedRead(handle, LIVE_FILE_MAX_BYTES);
        if (!owned(decoder.decode(bytes.subarray(0, HEAD_BYTES)), target, intents.get(where.value.dest), existing.value.fid)) return err('live-file-not-ours');
        if (over) return ok('differs');
        return ok((sha256Hex(deps, bytes)) === expectedSha ? 'match' : 'differs');
    } catch (e) {
        logger.warn('AiWorkspaces', 'Could not check the live pack file', e);
        return err('live-write-failed');
    } finally {
        if (handle) await handle.close().catch(() => undefined);
    }
}

/** The absolute destination of a target (for the intent journal and messages), or null when the folder is not usable now. */
export async function destinationPath(deps: LiveDeps, target: LiveTarget, vaultBase: string | null): Promise<string | null> {
    const where = await destinationOf(deps, target, vaultBase);
    return where.ok ? where.value.dest : null;
}

/** A device-local journal kept in Obsidian's local storage (never in synced settings). */
export function localStorageJournal(load: (key: string) => unknown, save: (key: string, value: unknown) => void, key = 'ai-organiser-live-intents'): IntentJournal {
    const read = (): Record<string, LiveIntent> => {
        const raw = load(key);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out: Record<string, LiveIntent> = {};
        for (const [dest, v] of Object.entries(raw as Record<string, unknown>)) {
            const i = v as Partial<LiveIntent> | null;
            if (i && typeof i.aioId === 'string' && typeof i.fid === 'string' && /^[0-9]{1,40}:[0-9]{1,40}$/.test(i.fid) && typeof i.generation === 'number' && typeof i.startedAt === 'string') out[dest] = { aioId: i.aioId, fid: i.fid, generation: i.generation, startedAt: i.startedAt };
        }
        return out;
    };
    return {
        get: (dest) => read()[dest] ?? null,
        set: (dest, intent) => save(key, { ...read(), [dest]: intent }),
        clear: (dest) => { const all = read(); delete all[dest]; save(key, all); },
        all: () => Object.entries(read()),
    };
}
