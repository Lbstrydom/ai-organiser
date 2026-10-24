/**
 * The local side of the offload: copy a vault file into a folder inside "Drive for desktop".
 *
 *  - Canonical containment: the mount root and the target are both resolved with `realpath`, and
 *    the target must stay inside the root after resolution. Symlink and junction escapes, `..`,
 *    reserved Windows names and over-long paths are refused.
 *  - Never overwrite: the destination is opened exclusively (`wx`). If a file of that name exists
 *    with identical content it is reused; if it differs, the copy gets `name-<8 hex of sha256>.ext`.
 *  - Large files are streamed with an incremental sha256, with progress and cancellation. The
 *    source must be stable (size and modified time unchanged) from before hashing until the copy ends.
 */
import { Result, ok, err } from '../../core/result';
import { hashStream, type NodeDeps, type StreamOptions } from './fingerprint';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME = 200;
const MAX_PATH = 240;

/** True when `name` is a single, safe file name. */
export function isSafeFileName(name: string): boolean {
    if (name === '' || name === '.' || name === '..' || name.length > MAX_NAME) return false;
    if (/[\\/:*?"<>|]/.test(name) || [...name].some((ch) => ch.charCodeAt(0) < 32)) return false;
    if (/[. ]$/.test(name) || RESERVED.test(name)) return false;
    return true;
}

/** True when either path is the other or sits inside it. Case-insensitive where the separator is a backslash (Windows). */
function overlaps(deps: NodeDeps, a: string, b: string): boolean {
    const fold = (p: string): string => (deps.path.sep === String.fromCharCode(92) ? p.toLowerCase() : p);
    const inside = (child: string, parent: string): boolean => {
        const rel = deps.path.relative(fold(parent), fold(child));
        return rel === '' || (!escapesRoot(deps, rel) && !deps.path.isAbsolute(rel));
    };
    return inside(a, b) || inside(b, a);
}

/**
 * Confirm the mount folder exists, is a directory and is not the vault (or inside it, or around it): offloading
 * into the vault would move nothing off it. Returns its canonical path. Writes nothing. It cannot tell whether
 * the folder really is Google Drive for desktop; that stays the person's to check.
 */
export async function checkMountFolder(deps: NodeDeps, mountRoot: string, vaultRoot?: string): Promise<Result<string>> {
    const root = mountRoot.trim();
    if (root === '' || !deps.path.isAbsolute(root)) return err('mount-invalid');
    try {
        const real = await deps.fs.promises.realpath(root);
        const stat = await deps.fs.promises.stat(real);
        if (!stat.isDirectory()) return err('mount-invalid');
        if (vaultRoot !== undefined && vaultRoot.trim() !== '') {
            // A vault folder that cannot be resolved leaves the question open, so the answer is no (never a guess from the text of the path).
            const vault = await deps.fs.promises.realpath(vaultRoot).catch(() => null);
            if (vault === null) return err('mount-vault-unverified');
            if (overlaps(deps, real, vault)) return err('mount-inside-vault');
        }
        return ok(real);
    } catch {
        return err('mount-missing');
    }
}

/** How long the settings button waits for an answer from a folder (a drive that is not connected can take far longer). */
export const MOUNT_CHECK_TIMEOUT_MS = 5000;
/** Probes that may be unresolved at once: a dead drive ties up a file-system thread for each, so more are refused, not queued. */
const MAX_PROBES_IN_FLIGHT = 3;
const probesInFlight = new Map<string, Promise<Result<string>>>();

/**
 * `checkMountFolder` with a time limit, for a button the person is waiting on. The operating-system probe of
 * a missing drive cannot be cancelled or shortened, so on a timeout the late answer is simply ignored; the probe
 * stays tracked until it settles. Asking again about the same folder reuses it, and only a few can be unresolved
 * at once, so repeated clicks cannot pile up work. The offload itself keeps the unbounded check: a slow answer
 * there is still an answer, and nothing is written yet.
 */
export async function checkMountFolderWithin(deps: NodeDeps, mountRoot: string, vaultRoot?: string, ms: number = MOUNT_CHECK_TIMEOUT_MS): Promise<Result<string>> {
    const key = `${mountRoot}
${vaultRoot ?? ''}`;
    let probe = probesInFlight.get(key);
    if (!probe) {
        if (probesInFlight.size >= MAX_PROBES_IN_FLIGHT) return err('mount-slow');
        const started = checkMountFolder(deps, mountRoot, vaultRoot);
        probe = started;
        probesInFlight.set(key, started);
        const forget = (): void => { if (probesInFlight.get(key) === started) probesInFlight.delete(key); };
        started.then(forget, forget);
    }
    let timer: number | undefined;
    const slow = new Promise<Result<string>>((resolve) => { timer = window.setTimeout(() => resolve(err('mount-slow')), ms); });
    try {
        return await Promise.race([probe, slow]);
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
    }
}

/** True when a relative path climbs out of its root: a leading `..` segment, not a name that merely starts with dots. */
function escapesRoot(deps: NodeDeps, rel: string): boolean {
    return rel === '..' || rel.startsWith(`..${deps.path.sep}`);
}

function contained(deps: NodeDeps, root: string, target: string): boolean {
    const rel = deps.path.relative(root, target);
    return rel !== '' && !escapesRoot(deps, rel) && !deps.path.isAbsolute(rel);
}

/** The absolute destination for `fileName` inside the mount root, with containment verified. */
export async function resolveDestination(deps: NodeDeps, realRoot: string, fileName: string): Promise<Result<string>> {
    if (!isSafeFileName(fileName)) return err('name-invalid');
    const dest = deps.path.join(realRoot, fileName);
    if (dest.length > MAX_PATH || !contained(deps, realRoot, dest)) return err('name-invalid');
    try {
        const st = await deps.fs.promises.lstat(dest);
        if (st.isSymbolicLink()) return err('name-invalid');
        const real = await deps.fs.promises.realpath(dest);
        if (!contained(deps, realRoot, real)) return err('name-invalid');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return err('name-invalid');
    }
    return ok(dest);
}

/** `report.pdf` + a hash -> `report-1a2b3c4d.pdf` */
export function collisionName(fileName: string, sha256: string): string {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    return `${stem}-${sha256.slice(0, 8)}${ext}`;
}

export interface CopyResult {
    /** Absolute path of the file in the mount folder */
    destPath: string;
    destName: string;
    sha256: string;
    size: number;
    /** An identical file was already there; nothing was copied */
    reused: boolean;
}

/** Copy `src` to a NEW file `dest`. Fails if `dest` exists. Hash is computed while copying. */
async function copyExclusive(deps: NodeDeps, src: string, dest: string, options: StreamOptions): Promise<Result<{ sha256: string; size: number }>> {
    if (options.signal?.aborted) return err('cancelled');
    const hash = deps.crypto.createHash('sha256');
    let size = 0;
    let created = false;
    /** Identity of the file this call created, so cleanup never removes something else at the same path */
    let ownIno: number | bigint | null = null;
    let out: ReturnType<typeof deps.fs.createWriteStream> | null = null;
    try {
        out = deps.fs.createWriteStream(dest, { flags: 'wx' });
        const target = out;
        const input = deps.fs.createReadStream(src, { highWaterMark: 1 << 20 });
        await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => { input.destroy(new Error('cancelled')); };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            target.on('open', (fd: number) => {
                created = true;
                deps.fs.fstat(fd, (e, st) => { if (!e) ownIno = st.ino; });
            });
            input.on('data', (chunk: string | Buffer) => {
                hash.update(chunk);
                size += chunk.length;
                try {
                    options.onProgress?.(size);
                } catch {
                    // A progress callback must never break the copy.
                }
            });
            input.on('error', (e) => { target.destroy(); options.signal?.removeEventListener('abort', onAbort); reject(e); });
            target.on('error', (e) => { input.destroy(); options.signal?.removeEventListener('abort', onAbort); reject(e); });
            target.on('finish', () => { options.signal?.removeEventListener('abort', onAbort); resolve(); });
            input.pipe(target);
        });
        return ok({ sha256: hash.digest('hex'), size });
    } catch (e) {
        // Wait for the destination to settle, then remove only a file this call created, never one that was already there.
        if (out && !out.closed) {
            const stream = out;
            await new Promise<void>((resolve) => { const t = window.setTimeout(resolve, 2000); stream.once('close', () => { window.clearTimeout(t); resolve(); }); stream.destroy(); });
        }
        if (created) {
            // Only if the path still names the file we made (when the identity is known).
            const st = await deps.fs.promises.lstat(dest).catch(() => null);
            if (st && (ownIno === null || st.ino === ownIno || st.ino === 0)) await deps.fs.promises.unlink(dest).catch(() => undefined);
        }
        if (options.signal?.aborted) return err('cancelled');
        return err((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'dest-exists' : 'copy-failed');
    }
}

/** True when both paths name the same file (same device and inode), or either cannot be told apart safely. */
async function isSameFile(deps: NodeDeps, a: string, b: string): Promise<boolean> {
    try {
        const [x, y] = await Promise.all([deps.fs.promises.stat(a), deps.fs.promises.stat(b)]);
        return x.dev === y.dev && x.ino === y.ino && x.ino !== 0;
    } catch {
        return true; // fail closed: if identity cannot be established, do not treat the file as an independent copy
    }
}

/**
 * Place `src` (whose fingerprint is known) into the mount folder under `wantedName`, following the
 * non-overwriting policy. The destination is hashed after the copy and compared with the source hash.
 */
export async function placeFile(
    deps: NodeDeps,
    realRoot: string,
    src: string,
    wantedName: string,
    expected: { sha256: string; size: number },
    options: StreamOptions = {},
): Promise<Result<CopyResult>> {
    const names = [wantedName, collisionName(wantedName, expected.sha256)];
    for (const name of names) {
        const dest = await resolveDestination(deps, realRoot, name);
        if (!dest.ok) return err(dest.error);
        let exists = true;
        try {
            await deps.fs.promises.lstat(dest.value);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
            else return err('copy-failed');
        }
        if (exists) {
            // A "copy" that is the source itself (same file, or a link to it) is not a second copy: trashing the
            // source afterwards would delete the only one.
            if (await isSameFile(deps, src, dest.value)) return err('dest-conflict');
            const hashed = await hashStream(deps, dest.value, options);
            if (!hashed.ok) return err(hashed.error);
            if (hashed.value.sha256 === expected.sha256 && hashed.value.bytes === expected.size) {
                return ok({ destPath: dest.value, destName: name, sha256: hashed.value.sha256, size: hashed.value.bytes, reused: true });
            }
            continue; // a different file is there: try the hash-suffixed name
        }
        const copied = await copyExclusive(deps, src, dest.value, options);
        if (!copied.ok) {
            if (copied.error === 'dest-exists') continue;
            return err(copied.error);
        }
        // The source must not have changed while it was being read, and the copy must match it.
        if (copied.value.sha256 !== expected.sha256 || copied.value.size !== expected.size) {
            await deps.fs.promises.unlink(dest.value).catch(() => undefined);
            return err('file-changed');
        }
        const verify = await hashStream(deps, dest.value, options);
        if (!verify.ok || verify.value.sha256 !== expected.sha256) {
            await deps.fs.promises.unlink(dest.value).catch(() => undefined);
            return err('copy-failed');
        }
        return ok({ destPath: dest.value, destName: name, sha256: expected.sha256, size: expected.size, reused: false });
    }
    return err('dest-conflict');
}
