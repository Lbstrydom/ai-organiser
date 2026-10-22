/**
 * Streamed file fingerprint (desktop). Large files are never buffered whole: the file is read in
 * bounded chunks, hashed incrementally with sha256, and checked for stability (size and modified
 * time unchanged before and after) so a file that is still being written is never trusted.
 *
 * The mobile duplicate stage keeps its capped `crypto.subtle` path; both are reached through the
 * `Fingerprinter` type so callers do not care which one they get.
 */
import { Result, ok, err } from '../../core/result';
import { desktopRequire } from '../../utils/desktopRequire';

/** The Node modules the offload needs. Absent on mobile. */
export interface NodeDeps {
    fs: typeof import('fs');
    path: typeof import('path');
    crypto: typeof import('crypto');
}

/** The Node modules, or null where they are not available (mobile). */
export function nodeDeps(): NodeDeps | null {
    const fs = desktopRequire<typeof import('fs')>('fs');
    const path = desktopRequire<typeof import('path')>('path');
    const crypto = desktopRequire<typeof import('crypto')>('crypto');
    return fs && path && crypto ? { fs, path, crypto } : null;
}

export interface Fingerprint {
    size: number;
    mtimeMs: number;
    sha256: string;
}

export interface StreamOptions {
    signal?: AbortSignal;
    /** Bytes processed so far */
    onProgress?: (bytes: number) => void;
}

/** A source of fingerprints; the streaming implementation is `streamFingerprinter`. */
export type Fingerprinter = (absolutePath: string, options?: StreamOptions) => Promise<Result<Fingerprint>>;

/** sha256 of a file read as a stream. Resolves with the hex digest and the number of bytes read. */
export function hashStream(deps: NodeDeps, absolutePath: string, options: StreamOptions = {}): Promise<Result<{ sha256: string; bytes: number }>> {
    return new Promise((resolve) => {
        if (options.signal?.aborted) return resolve(err('cancelled'));
        const hash = deps.crypto.createHash('sha256');
        let bytes = 0;
        let settled = false;
        const finish = (result: Result<{ sha256: string; bytes: number }>): void => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const stream = deps.fs.createReadStream(absolutePath, { highWaterMark: 1 << 20 });
        const onAbort = (): void => { stream.destroy(); finish(err('cancelled')); };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        stream.on('data', (chunk: string | Buffer) => {
            hash.update(chunk);
            bytes += chunk.length;
            try {
                options.onProgress?.(bytes);
            } catch {
                // A progress callback must never break the hash; its failure is ignored.
            }
        });
        stream.on('error', () => finish(err('read-failed')));
        stream.on('end', () => finish(ok({ sha256: hash.digest('hex'), bytes })));
    });
}

/** Fingerprint a file: stat, hash, stat again; any difference means the file was not stable. */
export function streamFingerprinter(deps: NodeDeps): Fingerprinter {
    return async (absolutePath, options = {}) => {
        try {
            const before = await deps.fs.promises.stat(absolutePath);
            if (!before.isFile()) return err('target-missing');
            const hashed = await hashStream(deps, absolutePath, options);
            if (!hashed.ok) return err(hashed.error);
            const after = await deps.fs.promises.stat(absolutePath);
            // Same size and time is not enough: the path may now name a different file (atomic replace).
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev || after.ctimeMs !== before.ctimeMs || hashed.value.bytes !== before.size) return err('file-changed');
            return ok({ size: after.size, mtimeMs: after.mtimeMs, sha256: hashed.value.sha256 });
        } catch {
            return err('read-failed');
        }
    };
}
