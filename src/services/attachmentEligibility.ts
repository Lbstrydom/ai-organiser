/**
 * Attachment eligibility: the single source of truth for "may this file be trashed (or, in the
 * offload feature, moved)?".
 *
 * A file is eligible only when ALL of these hold:
 *  - nothing resolves to it (zero references from notes or canvases),
 *  - no link could be read as pointing at it among several same-named files (ambiguity),
 *  - the scan had no coverage failure (an unreadable note or a malformed canvas could be hiding
 *    a reference, so it blocks every file),
 *  - it still looks like the file that was scanned (same path, size, modified time),
 *  - it is not inside a protected folder.
 *
 * The scan result answers this cheaply for display. Before anything is actually trashed,
 * `revalidate` rebuilds the reference graph from the CURRENT vault: it re-parses every referrer
 * that changed since the scan started, re-resolves every stored reference against each
 * referrer's current path (so a folder move that re-targets a relative link is caught even if an
 * event was missed), and fails closed if Obsidian is still indexing.
 */
import { App, TFile } from 'obsidian';
import { Result, ok, err } from '../core/result';
import { isProtectedPath, type ProtectedSource } from '../core/protectedPaths';
import { getMetadataIndexState, waitForMetadataIndex } from '../utils/metadataIndexState';
import { listAllReferrerFiles } from './referrerSet';
import {
    buildCandidateIndex,
    collectOccurrences,
    type CoverageFailure,
    type StoredOccurrence,
} from './embedScanService';

export type IneligibleReason =
    | 'still-referenced'
    | 'ambiguous-reference'
    | 'canvas-unreadable'
    | 'scan-incomplete'
    | 'file-changed'
    | 'target-missing'
    | 'protected-path';

export interface FileIdentity {
    path: string;
    size: number;
    mtime: number;
}

/** One note or canvas that references the file. */
export interface BlockerRef {
    path: string;
    extension: 'md' | 'canvas';
    /** 1-based line in a note; 0 for a canvas */
    lineNumber: number;
    /** The link text as written (normalised) */
    linktext: string;
}

/**
 * What stands in the way, so a kept file can say WHICH note, canvas or file to deal with. Evidence only:
 * it never changes the verdict, which `reasons` alone decide.
 */
export interface Blockers {
    referrers: BlockerRef[];
    /** Other vault files a link to this one could equally have meant */
    sameNameFiles: string[];
    /** Notes and canvases that could not be read (they may hide a reference) */
    unreadable: CoverageFailure[];
}

export interface Eligibility {
    eligible: boolean;
    reasons: IneligibleReason[];
    /** How many references resolve to the file */
    referenceCount: number;
    /** Present only on a delete-time re-check */
    blockers?: Blockers;
}

export interface EligibilityInput {
    /** The file as it was when scanned */
    scanned: FileIdentity;
    /** The file now, or null when it no longer exists at that path */
    current: FileIdentity | null;
    referenceCount: number;
    ambiguous: boolean;
    coverageFailures: readonly CoverageFailure[];
    protectedFolders: ProtectedSource;
    blockers?: Blockers;
}

/** Pure eligibility decision. */
export function computeEligibility(input: EligibilityInput): Eligibility {
    const reasons: IneligibleReason[] = [];
    if (!input.current) {
        reasons.push('target-missing');
    } else if (input.current.size !== input.scanned.size || input.current.mtime !== input.scanned.mtime) {
        reasons.push('file-changed');
    }
    if (isProtectedPath(input.protectedFolders, input.scanned.path)) reasons.push('protected-path');
    if (input.referenceCount > 0) reasons.push('still-referenced');
    if (input.ambiguous) reasons.push('ambiguous-reference');
    if (input.coverageFailures.some((f) => f.kind === 'canvas-unreadable')) reasons.push('canvas-unreadable');
    if (input.coverageFailures.some((f) => f.kind === 'markdown-unreadable')) reasons.push('scan-incomplete');
    const verdict: Eligibility = { eligible: reasons.length === 0, reasons, referenceCount: input.referenceCount };
    if (input.blockers) verdict.blockers = input.blockers;
    return verdict;
}

// ─── Revalidation at confirmation ────────────────────────────────────────────

export interface ReferrerInfo {
    path: string;
    extension: 'md' | 'canvas';
    mtime: number;
}

/** What revalidation needs from the vault. Implemented over Obsidian below; faked in tests. */
export interface AttachmentVaultPort {
    /** Called at the start of every revalidation attempt: drop anything cached from an earlier one. */
    beginAttempt?(): void;
    /** A value that changes whenever a file is added, removed or renamed anywhere in the vault. */
    namespaceSignature?(): string;
    isResolved(): boolean;
    /** Wait up to `timeoutMs` for Obsidian's link index to settle. Resolves false on timeout. */
    waitResolved(timeoutMs: number): Promise<boolean>;
    /** Every markdown note and canvas in the vault. */
    listReferrers(): ReferrerInfo[];
    readText(path: string): Promise<string | null>;
    /** Resolve link text from a referrer to a vault path, or null. */
    resolveLink(linktext: string, sourcePath: string): string | null;
    /** Vault paths a link text could mean (for ambiguity). */
    candidatesFor(linktext: string): string[];
    identity(path: string): FileIdentity | null;
}

/** Vault changes recorded since the scan started. */
export interface ChangeSet {
    created: ReadonlySet<string>;
    /** New paths of anything renamed or moved */
    renamed: ReadonlySet<string>;
    modified: ReadonlySet<string>;
    deleted: ReadonlySet<string>;
}

export const EMPTY_CHANGES: ChangeSet = {
    created: new Set(),
    renamed: new Set(),
    modified: new Set(),
    deleted: new Set(),
};

export interface RevalidationInput {
    /** The files proposed for trashing, as they were scanned */
    files: readonly FileIdentity[];
    scanStartedAt: number;
    occurrences: readonly StoredOccurrence[];
    /** Referrers the scan actually read, with their modified time then. A referrer that is not
     *  listed (never scanned, or moved here since) or whose time differs is read again. When this
     *  is absent nothing can be trusted from the scan, so every referrer is read again. */
    scannedReferrers?: readonly { path: string; mtime: number }[];
    /** Referrers the scan could not read; they are tried again here rather than ignored */
    priorFailures?: readonly CoverageFailure[];
    changes: ChangeSet;
    protectedFolders: ProtectedSource;
    /** Bounded wait for the link index (default 5000 ms) */
    waitMs?: number;
}

/**
 * Rebuild the reference graph from the current vault and decide eligibility for each file.
 * Fails closed: if Obsidian has not finished indexing, nothing is eligible (`metadata-not-ready`).
 */
export async function revalidate(
    port: AttachmentVaultPort,
    input: RevalidationInput,
): Promise<Result<Map<string, Eligibility>>> {
    // The graph is rebuilt from async reads, so the vault can move underneath it. Rebuild until
    // the referrer set is identical before and after; give up (fail closed) after three tries.
    for (let attempt = 0; attempt < 3; attempt++) {
        port.beginAttempt?.();
        const ready = port.isResolved() || (await port.waitResolved(input.waitMs ?? 5000));
        if (!ready) return err('metadata-not-ready');
        const before = referrerSignature(port.listReferrers()) + (port.namespaceSignature?.() ?? '');
        const built = await buildEligibility(port, input);
        if (referrerSignature(port.listReferrers()) + (port.namespaceSignature?.() ?? '') === before) return ok(built);
    }
    return err('scan-out-of-date');
}

function referrerSignature(referrers: readonly ReferrerInfo[]): string {
    return referrers.map((r) => `${r.path}\u0000${r.mtime}`).sort().join('\u0001');
}

async function buildEligibility(
    port: AttachmentVaultPort,
    input: RevalidationInput,
): Promise<Map<string, Eligibility>> {
    const referrers = port.listReferrers();
    const live = new Map(referrers.map((r) => [r.path, r]));
    const scanned = input.scannedReferrers ? new Map(input.scannedReferrers.map((r) => [r.path, r.mtime])) : null;
    const stale = (r: ReferrerInfo): boolean =>
        scanned === null ||
        !scanned.has(r.path) ||
        scanned.get(r.path) !== r.mtime ||
        r.mtime > input.scanStartedAt ||
        input.changes.created.has(r.path) ||
        input.changes.renamed.has(r.path) ||
        input.changes.modified.has(r.path);

    const occurrences: StoredOccurrence[] = [];
    const failures: CoverageFailure[] = [];

    // Referrers unchanged since the scan: reuse their stored occurrences (if the referrer still exists there).
    const reparse = new Set(referrers.filter(stale).map((r) => r.path));
    for (const failure of input.priorFailures ?? []) {
        if (live.has(failure.path)) reparse.add(failure.path);
    }
    for (const occ of input.occurrences) {
        if (live.has(occ.referrerPath) && !reparse.has(occ.referrerPath)) occurrences.push(occ);
    }
    // Referrers that are new or changed: parse them again from their current text.
    for (const path of reparse) {
        const info = live.get(path)!;
        const text = await port.readText(path);
        if (text === null) {
            failures.push({ path, kind: info.extension === 'canvas' ? 'canvas-unreadable' : 'markdown-unreadable' });
            continue;
        }
        const collected = collectOccurrences(path, info.extension, text);
        if (collected.failure) {
            failures.push(collected.failure);
            continue;
        }
        occurrences.push(...collected.occurrences);
    }
    // Re-resolve every occurrence against its referrer's CURRENT path.
    const counts = new Map<string, number>();
    const refsByTarget = new Map<string, BlockerRef[]>();
    const ambiguous = new Set<string>();
    const sameName = new Map<string, Set<string>>();
    const ambiguityDone = new Set<string>();
    for (const occ of occurrences) {
        const target =
            occ.kind === 'canvas'
                ? (port.identity(occ.linktext)?.path ?? port.resolveLink(occ.linktext, occ.referrerPath))
                : port.resolveLink(occ.linktext, occ.referrerPath);
        if (target) {
            counts.set(target, (counts.get(target) ?? 0) + 1);
            const list = refsByTarget.get(target) ?? [];
            list.push({
                path: occ.referrerPath,
                extension: live.get(occ.referrerPath)?.extension ?? (occ.kind === 'canvas' ? 'canvas' : 'md'),
                lineNumber: occ.lineNumber,
                linktext: occ.linktext,
            });
            refsByTarget.set(target, list);
        }
        // Which files a link text could mean depends on the text alone, so work it out once per distinct text.
        if (occ.kind === 'markdown' && !ambiguityDone.has(occ.linktext)) {
            ambiguityDone.add(occ.linktext);
            const candidates = port.candidatesFor(occ.linktext);
            if (candidates.length > 1) {
                for (const c of candidates) {
                    ambiguous.add(c);
                    const others = sameName.get(c) ?? new Set<string>();
                    for (const other of candidates) if (other !== c) others.add(other);
                    sameName.set(c, others);
                }
            }
        }
    }

    // Unreadable referrers are listed once each; they may hide a reference to ANY file.
    const unreadable = [...new Map(failures.map((f) => [f.path, f])).values()];

    const result = new Map<string, Eligibility>();
    for (const scanned of input.files) {
        result.set(
            scanned.path,
            computeEligibility({
                scanned,
                current: port.identity(scanned.path),
                referenceCount: counts.get(scanned.path) ?? 0,
                ambiguous: ambiguous.has(scanned.path),
                coverageFailures: failures,
                protectedFolders: input.protectedFolders,
                blockers: {
                    referrers: refsByTarget.get(scanned.path) ?? [],
                    sameNameFiles: [...(sameName.get(scanned.path) ?? [])],
                    unreadable,
                },
            }),
        );
    }
    return result;
}

// ─── Obsidian-backed port ────────────────────────────────────────────────────

/** Build the port over a live `App`. */
export function createAppVaultPort(app: App): AttachmentVaultPort {
    // One index per port (one revalidation), built on first use and reused for every occurrence.
    let index: ((linktext: string) => string[]) | null = null;
    const candidatesFor = (linktext: string): string[] => {
        index ??= buildCandidateIndex(app.vault.getFiles().map((f) => f.path));
        return index(linktext);
    };
    return {
        beginAttempt: () => { index = null; },
        namespaceSignature: () => app.vault.getFiles().map((f) => f.path).sort().join('\u0001'),
        // This gate feeds the Drive offload (a trash after link rewrites), so an index that is building
        // OR whose state cannot be established is not "resolved" (see utils/metadataIndexState). Renames
        // and moves are covered twice: the cache queues their relinking (the live state reads "building"),
        // and `namespaceSignature` below lets the barrier notice a changed vault.
        isResolved: () => getMetadataIndexState(app) === 'ready',
        waitResolved: async (timeoutMs) => (await waitForMetadataIndex(app, { timeoutMs })).outcome === 'ready',
        // The same enumeration the scan uses (services/referrerSet), so the two cannot disagree.
        listReferrers: () =>
            listAllReferrerFiles(app).map((f) => ({
                path: f.path,
                extension: f.extension === 'canvas' ? ('canvas' as const) : ('md' as const),
                mtime: f.stat.mtime,
            })),
        readText: async (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return null;
            try {
                return await app.vault.cachedRead(file);
            } catch {
                return null;
            }
        },
        resolveLink: (linktext, sourcePath) => app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null,
        candidatesFor,
        identity: (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? { path: file.path, size: file.stat.size, mtime: file.stat.mtime } : null;
        },
    };
}

// ─── Change tracking ─────────────────────────────────────────────────────────

/** Mutable recorder for vault events since a scan began. */
export class ChangeLog {
    private created = new Set<string>();
    private renamed = new Set<string>();
    private modified = new Set<string>();
    private deleted = new Set<string>();

    recordCreate(path: string): void { this.created.add(path); }
    recordModify(path: string): void { this.modified.add(path); }
    recordDelete(path: string): void { this.deleted.add(path); }
    recordRename(oldPath: string, newPath: string): void {
        this.renamed.add(newPath);
        this.deleted.add(oldPath);
    }

    get isEmpty(): boolean {
        return this.created.size + this.renamed.size + this.modified.size + this.deleted.size === 0;
    }

    snapshot(): ChangeSet {
        return {
            created: new Set(this.created),
            renamed: new Set(this.renamed),
            modified: new Set(this.modified),
            deleted: new Set(this.deleted),
        };
    }
}

/**
 * Eligibility straight from a scan result (cheap, for display). Authoritative checking is
 * `revalidate` at confirmation.
 */
export function eligibilityFromScan(
    scanned: FileIdentity,
    referenceCount: number,
    ambiguous: boolean,
    coverageFailures: readonly CoverageFailure[],
    protectedFolders: ProtectedSource,
): Eligibility {
    return computeEligibility({
        scanned,
        current: scanned,
        referenceCount,
        ambiguous,
        coverageFailures,
        protectedFolders,
    });
}
