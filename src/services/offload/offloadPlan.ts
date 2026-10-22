/**
 * Offload plans. Pure builders for the two approvals:
 *
 *  1. The COPY plan (approved at "Start offload", persisted immutably): which file, where it goes and
 *     which references will later become Drive links. It cannot contain the final text because the
 *     replacement depends on the Drive file id, which only exists after the copy has synced.
 *  2. The REWRITE plan (built after the Drive file was captured, approved in "Final review"): for each
 *     referrer, the exact before and after, with the real link.
 */
import { Result, ok, err } from '../../core/result';
import { sha256Hex } from '../attachmentDuplicateService';
import { driveFileLink } from '../cloudInventory/inventoryBlock';
import type { CloudInventoryPair } from '../../core/settings';
import { isProtectedPath, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { transformCanvas } from '../canvas/canvasWritePort';
import { applyEdits, hasUnsupported, renderLink, type Occurrence, type TextEdit } from './referenceOccurrences';

export async function textHash(text: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(text).buffer);
}

// ─── Pair choice ────────────────────────────────────────────────────────────

/** Pairs that can receive a file: those with a local Drive folder. */
export function offloadablePairs(pairs: readonly CloudInventoryPair[]): CloudInventoryPair[] {
    return pairs.filter((p) => (p.localMountFolder ?? '').trim() !== '');
}

/** The pair whose vault folder contains the file, if exactly one does; otherwise the user must choose. */
export function suggestPair(pairs: readonly CloudInventoryPair[], filePath: string): CloudInventoryPair | null {
    const usable = offloadablePairs(pairs);
    if (usable.length === 1) return usable[0];
    const norm = normalisePath(filePath).toLowerCase();
    const inside = usable.filter((p) => {
        const folder = normalisePath(p.vaultFolder).toLowerCase();
        return folder === '' || norm === folder || norm.startsWith(`${folder}/`);
    });
    if (inside.length === 0) return null;
    // The most specific folder wins when it is unambiguous.
    const longest = Math.max(...inside.map((p) => normalisePath(p.vaultFolder).length));
    const best = inside.filter((p) => normalisePath(p.vaultFolder).length === longest);
    return best.length === 1 ? best[0] : null;
}

// ─── Copy plan ──────────────────────────────────────────────────────────────

export type ReferrerKind = 'md' | 'canvas';

export interface PlannedReferrer {
    path: string;
    kind: ReferrerKind;
    /** sha256 of the referrer text when the plan was made */
    baselineHash: string;
    occurrences: Array<Pick<Occurrence, 'kind' | 'start' | 'end' | 'original' | 'display' | 'subpath' | 'nodeId'>>;
}

export interface CopyPlan {
    opId: string;
    createdAt: string;
    source: { path: string; size: number; mtimeMs: number; sha256: string };
    pairId: string;
    driveFolderId: string;
    /** Name the file will have in the Drive folder (may become hash-suffixed on a collision) */
    destName: string;
    referrers: PlannedReferrer[];
}

export interface CopyPlanInput {
    opId: string;
    now: string;
    source: CopyPlan['source'];
    pair: CloudInventoryPair;
    referrers: ReadonlyArray<{ path: string; kind: ReferrerKind; text: string; occurrences: readonly Occurrence[] }>;
    protectedFolders: ProtectedSource;
}

/**
 * Build the copy plan. Refuses (with a stable code) when an occurrence cannot be rewritten, when
 * the source or a referrer is protected, or when nothing refers to the file (then there is nothing
 * to offload but the file itself, which is a plain move and not this feature).
 */
export async function buildCopyPlan(input: CopyPlanInput): Promise<Result<CopyPlan>> {
    if (isProtectedPath(input.protectedFolders, input.source.path)) return err('protected-path');
    const referrers: PlannedReferrer[] = [];
    for (const r of input.referrers) {
        if (r.occurrences.length === 0) continue;
        if (hasUnsupported(r.occurrences)) return err('unsupported-reference');
        if (isProtectedPath(input.protectedFolders, r.path)) return err('protected-path');
        referrers.push({
            path: r.path,
            kind: r.kind,
            baselineHash: await textHash(r.text),
            occurrences: r.occurrences.map((o) => ({ kind: o.kind, start: o.start, end: o.end, original: o.original, display: o.display, subpath: o.subpath, nodeId: o.nodeId })),
        });
    }
    const name = input.source.path.slice(input.source.path.lastIndexOf('/') + 1);
    return ok({
        opId: input.opId,
        createdAt: input.now,
        source: input.source,
        pairId: input.pair.id,
        driveFolderId: input.pair.driveFolderId,
        destName: name,
        referrers,
    });
}

// ─── Rewrite plan ───────────────────────────────────────────────────────────

export interface RemoteIdentity {
    id: string;
    name: string;
    size: number;
    sha256: string;
    parent: string;
}

export interface RewriteItem {
    path: string;
    kind: ReferrerKind;
    baselineHash: string;
    expectedAfterHash: string;
    /** Markdown: the text edits. Canvas: empty (the nodes are listed in `nodeIds`). */
    edits: TextEdit[];
    nodeIds: string[];
    /** For the Final review step: what each occurrence looks like before and after */
    preview: Array<{ before: string; after: string }>;
}

export interface RewritePlan {
    remote: RemoteIdentity;
    url: string;
    items: RewriteItem[];
}

/** One-line match rule for the Drive listing: name, size and sha256 must all agree. */
export function matchRemote(
    files: ReadonlyArray<{ id: string; name: string; size: number | null; sha256Checksum?: string }>,
    expected: { name: string; size: number; sha256: string },
    parent: string,
): { state: 'none' } | { state: 'many' } | { state: 'one'; remote: RemoteIdentity } {
    const hits = files.filter((f) => f.name === expected.name && f.size === expected.size && f.sha256Checksum?.toLowerCase() === expected.sha256.toLowerCase());
    if (hits.length === 0) return { state: 'none' };
    if (hits.length > 1) return { state: 'many' };
    const f = hits[0];
    return { state: 'one', remote: { id: f.id, name: f.name, size: expected.size, sha256: expected.sha256, parent } };
}

/**
 * Build the rewrite plan from the captured Drive file and the CURRENT text of each referrer.
 * A referrer whose text no longer matches the plan-time hash is reported (`referrer-changed`) so the
 * caller can drop it from the approval rather than overwrite the user's newer edit.
 */
export async function buildRewritePlan(
    copy: CopyPlan,
    remote: RemoteIdentity,
    texts: ReadonlyMap<string, string>,
): Promise<Result<{ plan: RewritePlan; changed: string[] }>> {
    const url = driveFileLink(remote.id);
    if (!url) return err('script-bad-response');
    const info = { url, fileName: remote.name, sizeBytes: remote.size };
    const items: RewriteItem[] = [];
    const changed: string[] = [];
    for (const r of copy.referrers) {
        const text = texts.get(r.path);
        if (text === undefined || (await textHash(text)) !== r.baselineHash) { changed.push(r.path); continue; }
        if (r.kind === 'canvas') {
            const nodeIds = r.occurrences.map((o) => o.nodeId ?? '').filter(Boolean);
            const next = transformCanvas(text, nodeIds.map((nodeId) => ({ nodeId, url })));
            if (!next.ok) return err(next.error);
            items.push({ path: r.path, kind: 'canvas', baselineHash: r.baselineHash, expectedAfterHash: await textHash(next.value), edits: [], nodeIds, preview: nodeIds.map((id) => ({ before: `file node ${id}`, after: `link node → ${url}` })) });
            continue;
        }
        const edits: TextEdit[] = r.occurrences.map((o) => ({ start: o.start, end: o.end, text: renderLink({ ...o, referrerPath: r.path } as Occurrence, info) }));
        let after: string;
        try {
            after = applyEdits(text, edits);
        } catch {
            return err('unsupported-reference');
        }
        items.push({
            path: r.path,
            kind: 'md',
            baselineHash: r.baselineHash,
            expectedAfterHash: await textHash(after),
            edits,
            nodeIds: [],
            preview: r.occurrences.map((o, i) => ({ before: o.original, after: edits[i].text })),
        });
    }
    return ok({ plan: { remote, url, items }, changed });
}
