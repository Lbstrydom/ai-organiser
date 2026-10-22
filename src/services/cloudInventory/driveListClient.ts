/**
 * Drive listing client: walks an approved Drive folder through the user's Apps Script.
 *
 * Iterative breadth-first walk, driven by the client: each subfolder is requested separately and
 * each request is authorised by the script. Safety rails:
 *  - a visited-ID set (a Drive shortcut loop cannot trap the walk);
 *  - page-token repeat detection (a repeated token aborts that folder);
 *  - limits on folders, files and total time, with a concurrency of 2;
 *  - cancellation;
 *  - a listing that hit a limit is `truncated` and one that failed is `failed`; neither is ever
 *    presented as complete.
 */
import { Result } from '../../core/result';
import type { InventoryFile } from './inventoryBlock';

/** One page of the script's `list` answer. */
export interface ListPage {
    files: Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: string | number;
        modifiedTime?: string;
        md5Checksum?: string;
        sha256Checksum?: string;
    }>;
    folders: Array<{ id: string; name: string }>;
    nextPageToken: string | null;
}

export interface TreeLimits {
    maxFolders: number;
    maxFiles: number;
    deadlineMs: number;
    concurrency?: number;
}

export type TreeStatus = 'complete' | 'truncated' | 'failed';

export interface TreeListing {
    status: TreeStatus;
    files: InventoryFile[];
    /** Stable error code when `status` is `failed` */
    error?: string;
    foldersVisited: number;
}

export interface ListTreeOptions {
    rootFolderId: string;
    /** Calls the script's `list` for one folder page */
    fetchPage: (folderId: string, pageToken: string | null) => Promise<Result<ListPage>>;
    limits: TreeLimits;
    signal?: AbortSignal;
    now?: () => number;
    onProgress?: (foldersVisited: number, filesFound: number) => void;
}

function toSize(value: string | number | undefined): number | null {
    if (value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Walk the tree. Never throws. */
export async function listDriveTree(options: ListTreeOptions): Promise<TreeListing> {
    const { limits, fetchPage } = options;
    const now = options.now ?? (() => Date.now());
    const deadline = now() + limits.deadlineMs;
    const queue: Array<{ id: string; path: string }> = [{ id: options.rootFolderId, path: '' }];
    const visited = new Set<string>([options.rootFolderId]);
    const files: InventoryFile[] = [];
    let truncated = false;
    let failure: string | null = null;
    let foldersVisited = 0;
    const concurrency = Math.max(1, Math.floor(limits.concurrency ?? 2));

    const stop = (): boolean => failure !== null || options.signal?.aborted === true;

    const visit = async (folder: { id: string; path: string }): Promise<void> => {
        let token: string | null = null;
        const tokens = new Set<string>();
        do {
            if (stop()) return;
            if (now() > deadline) { truncated = true; return; }
            const res: Result<ListPage> = await fetchPage(folder.id, token);
            if (!res.ok) { failure = res.error; return; }
            for (const f of res.value.files) {
                if (files.length >= limits.maxFiles) { truncated = true; return; }
                files.push({
                    id: f.id,
                    name: f.name,
                    mimeType: f.mimeType,
                    size: toSize(f.size),
                    modifiedTime: f.modifiedTime ?? '',
                    md5Checksum: f.md5Checksum,
                    sha256Checksum: f.sha256Checksum,
                    path: folder.path,
                });
            }
            for (const sub of res.value.folders) {
                if (visited.has(sub.id)) continue;
                if (visited.size >= limits.maxFolders) { truncated = true; continue; }
                visited.add(sub.id);
                queue.push({ id: sub.id, path: folder.path ? `${folder.path}/${sub.name}` : sub.name });
            }
            const next: string | null = res.value.nextPageToken;
            if (next && tokens.has(next)) return; // a repeated token would loop forever: abort this folder
            if (next) tokens.add(next);
            token = next;
        } while (token);
    };

    // Workers pull from the queue until it is empty AND no sibling is still expanding a folder.
    let active = 0;
    const loop = async (): Promise<void> => {
        for (;;) {
            if (stop()) return;
            const folder = queue.shift();
            if (!folder) {
                if (active === 0) return;
                await new Promise((r) => window.setTimeout(r, 0));
                continue;
            }
            active++;
            foldersVisited++;
            try {
                await visit(folder);
            } finally {
                active--;
            }
            options.onProgress?.(foldersVisited, files.length);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, loop));

    if (options.signal?.aborted) return { status: 'failed', files: [], error: 'cancelled', foldersVisited };
    if (failure !== null) return { status: 'failed', files: [], error: failure, foldersVisited };
    return { status: truncated ? 'truncated' : 'complete', files, foldersVisited };
}
