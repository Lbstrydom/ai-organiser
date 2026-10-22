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

/** Confirm the mount folder exists and is a directory. Returns its canonical path. Writes nothing. */
export async function checkMountFolder(deps: NodeDeps, mountRoot: string): Promise<Result<string>> {
    const root = mountRoot.trim();
    if (root === '' || !deps.path.isAbsolute(root)) return err('mount-invalid');
    try {
        const real = await deps.fs.promises.realpath(root);
        const stat = await deps.fs.promises.stat(real);
        return stat.isDirectory() ? ok(real) : err('mount-invalid');
    } catch {
        return err('mount-missing');
    }
}

function contained(deps: NodeDeps, root: string, target: string): boolean {
    const rel = deps.path.relative(root, target);
    return rel !== '' && !rel.startsWith('..') && !deps.path.isAbsolute(rel);
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
    try {
        const out = deps.fs.createWriteStream(dest, { flags: 'wx' });
        const input = deps.fs.createReadStream(src, { highWaterMark: 1 << 20 });
        await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => { input.destroy(new Error('cancelled')); };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            out.on('open', () => { created = true; });
            input.on('data', (chunk: string | Buffer) => {
                hash.update(chunk);
                size += chunk.length;
                try {
                    options.onProgress?.(size);
                } catch {
                    // A progress callback must never break the copy.
                }
            });
            input.on('error', (e) => { out.destroy(); options.signal?.removeEventListener('abort', onAbort); reject(e); });
            out.on('error', (e) => { input.destroy(); options.signal?.removeEventListener('abort', onAbort); reject(e); });
            out.on('finish', () => { options.signal?.removeEventListener('abort', onAbort); resolve(); });
            input.pipe(out);
        });
        return ok({ sha256: hash.digest('hex'), size });
    } catch (e) {
        // Remove only a file this call created, never one that was already there.
        if (created) await deps.fs.promises.unlink(dest).catch(() => undefined);
        if (options.signal?.aborted) return err('cancelled');
        return err((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'dest-exists' : 'copy-failed');
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
