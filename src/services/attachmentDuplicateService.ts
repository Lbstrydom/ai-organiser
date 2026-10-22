/**
 * Duplicate analysis for attachments: an opt-in stage, separate from the reference scan.
 *
 * Files are grouped by size first (a file with a unique size cannot have a duplicate), then
 * only the candidates are hashed with sha256 at a concurrency of 2. Files above the size cap
 * get a "not analysed" status instead of being read whole into memory. Progress is reported
 * and the run can be cancelled between files; a cancelled run returns what it found, labelled.
 */

export interface DuplicateFile {
    path: string;
    size: number;
}

export interface DuplicateGroup {
    hash: string;
    size: number;
    paths: string[];
}

export type NotAnalysedReason = 'over-cap' | 'read-failed';

export interface DuplicateResult {
    groups: DuplicateGroup[];
    notAnalysed: { path: string; reason: NotAnalysedReason }[];
    /** Files whose hash was computed */
    analysed: number;
    cancelled: boolean;
}

export interface DuplicatePort {
    readBinary(path: string): Promise<ArrayBuffer>;
}

export interface DuplicateOptions {
    /** Files larger than this many bytes are not hashed */
    maxBytes: number;
    /** How many files are hashed at once (default 2) */
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, path: string) => void;
}

/** Lower-case hex sha256 of a buffer, using the Web Crypto API (works on desktop and mobile). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keep only files that share their size with at least one other file. Pure. */
export function groupBySize(files: readonly DuplicateFile[]): Map<number, DuplicateFile[]> {
    const bySize = new Map<number, DuplicateFile[]>();
    for (const file of files) {
        const list = bySize.get(file.size);
        if (list) list.push(file);
        else bySize.set(file.size, [file]);
    }
    for (const [size, list] of bySize) {
        if (list.length < 2) bySize.delete(size);
    }
    return bySize;
}

/** Find byte-identical files among `files`. Never throws. */
export async function analyseDuplicates(
    files: readonly DuplicateFile[],
    port: DuplicatePort,
    options: DuplicateOptions,
): Promise<DuplicateResult> {
    const candidates = [...groupBySize(files).values()].flat();
    const notAnalysed: DuplicateResult['notAnalysed'] = [];
    const hashable: DuplicateFile[] = [];
    for (const file of candidates) {
        if (file.size > options.maxBytes) notAnalysed.push({ path: file.path, reason: 'over-cap' });
        else hashable.push(file);
    }

    const hashes = new Map<string, DuplicateFile[]>();
    let done = 0;
    let cancelled = false;
    let next = 0;
    const concurrency = Math.max(1, options.concurrency ?? 2);

    const worker = async (): Promise<void> => {
        for (;;) {
            if (options.signal?.aborted) {
                cancelled = true;
                return;
            }
            const index = next++;
            if (index >= hashable.length) return;
            const file = hashable[index];
            try {
                const hash = await sha256Hex(await port.readBinary(file.path));
                const key = `${file.size}:${hash}`;
                const list = hashes.get(key);
                if (list) list.push(file);
                else hashes.set(key, [file]);
            } catch {
                notAnalysed.push({ path: file.path, reason: 'read-failed' });
            }
            done++;
            try {
                options.onProgress?.(done, hashable.length, file.path);
            } catch {
                // An observer failing must not abort the analysis.
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, hashable.length)) }, worker));

    const groups: DuplicateGroup[] = [];
    for (const [key, list] of hashes) {
        if (list.length < 2) continue;
        groups.push({ hash: key.split(':')[1], size: list[0].size, paths: list.map((f) => f.path).sort() });
    }
    groups.sort((a, b) => b.size - a.size || a.paths[0].localeCompare(b.paths[0]));
    return { groups, notAnalysed, analysed: done, cancelled };
}
