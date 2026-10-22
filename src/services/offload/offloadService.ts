/**
 * Offload orchestrator: copy -> remote capture -> rewrite -> verify -> trash.
 *
 * Everything the outside world provides comes through `OffloadDeps`, so the whole flow is tested
 * with fakes. The journal is saved after every step; recovery is decided from observable
 * postconditions (the file in the Drive folder, the text of each referrer, the vault), never from
 * the journal alone. The local file is trashed only after the commit barrier passes, and through
 * the Obsidian trash, so a mistake is recoverable.
 */
import { Result, ok, err } from '../../core/result';
import { applyEdits } from './referenceOccurrences';
import { checkMountFolder, placeFile } from './localMount';
import { evaluateBarrier, type BarrierReason, type ReferrerStatus } from './commitBarrier';
import {
    JournalStore,
    isTerminal,
    transition,
    type OffloadRecord,
} from './offloadJournal';
import { buildRewritePlan, matchRemote, textHash, type RewritePlan } from './offloadPlan';
import type { Fingerprinter, NodeDeps, StreamOptions } from './fingerprint';
import { isProtectedPath, type ProtectedSource } from '../../core/protectedPaths';

export interface RemoteListFile {
    id: string;
    name: string;
    size: number | null;
    sha256Checksum?: string;
}

export interface VaultWatch {
    /** Stop watching; returns how many relevant vault events happened meanwhile */
    stop(): number;
}

export interface OffloadDeps {
    now(): string;
    node: NodeDeps;
    fingerprint: Fingerprinter;
    store: JournalStore;
    /** Absolute path of the vault root on disk */
    vaultBasePath: string;
    protectedFolders(): ProtectedSource;
    /** The local Drive for desktop folder of a pair */
    mountRoot(pairId: string): string | undefined;

    readText(path: string): Promise<string | null>;
    exists(path: string): boolean;
    writeMarkdown(path: string, baseline: string, next: string): Promise<Result<void>>;
    writeCanvas(path: string, nodeIds: readonly string[], url: string, baseline: string): Promise<Result<void>>;
    /** Move the file to the trash. `expected` is the identity the barrier verified; the port refuses if the file no longer matches it. */
    trash(path: string, expected: { size: number; mtimeMs: number }): Promise<Result<void>>;

    /** One-folder Drive listing (no recursion) */
    listFolder(folderId: string): Promise<Result<RemoteListFile[]>>;
    /** Fresh authoritative reference scan for the source file */
    scanReferences(sourcePath: string): Promise<Result<{ remaining: number; coverageFailures: number }>>;
    watch(): VaultWatch;

    options?: StreamOptions;
}

export type Waiting = 'none' | 'drive-sync' | 'rewrite-approval' | 'blocked' | 'done';

export interface AdvanceOutcome {
    record: OffloadRecord;
    waiting: Waiting;
    /** Set when the journal could not be written: the state shown may be ahead of what is saved */
    persistError?: string;
}

async function save(deps: OffloadDeps, record: OffloadRecord): Promise<Result<OffloadRecord>> {
    const saved = await deps.store.put(record);
    return saved.ok ? ok(record) : err(saved.error);
}

function sourceAbsolute(deps: OffloadDeps, path: string): string {
    return deps.node.path.join(deps.vaultBasePath, ...path.split('/'));
}

/** The newest saved version of a record: a stage may have saved progress the caller has not seen. */
async function latest(deps: OffloadDeps, record: OffloadRecord): Promise<OffloadRecord> {
    const all = await deps.store.load();
    return (all.ok ? all.value.find((r) => r.opId === record.opId) : undefined) ?? record;
}

async function fail(deps: OffloadDeps, entry: OffloadRecord, code: string): Promise<AdvanceOutcome> {
    const record = await latest(deps, entry);
    const next = transition(record, 'failed', deps.now(), { blocked: code });
    const final = next.ok ? next.value : { ...record, step: 'failed' as const, blocked: code };
    const saved = await deps.store.put(final);
    return saved.ok ? { record: final, waiting: 'blocked' } : { record: final, waiting: 'blocked', persistError: saved.error };
}

/** Keep the record at its step, note why it is waiting. */
async function hold(deps: OffloadDeps, record: OffloadRecord, code: string, waiting: Waiting): Promise<AdvanceOutcome> {
    const held = { ...record, blocked: code, updatedAt: deps.now() };
    const saved = await deps.store.put(held);
    return saved.ok ? { record: held, waiting } : { record: held, waiting, persistError: saved.error };
}

// ─── Start ──────────────────────────────────────────────────────────────────

/** Persist the approved copy plan; nothing else happens yet. */
export async function startOffload(deps: OffloadDeps, record: OffloadRecord): Promise<Result<OffloadRecord>> {
    return save(deps, record);
}

// ─── Copy ───────────────────────────────────────────────────────────────────

async function copyStage(deps: OffloadDeps, record: OffloadRecord): Promise<AdvanceOutcome> {
    const { copy } = record;
    if (!deps.exists(copy.source.path)) return fail(deps, record, 'source-missing');
    const abs = sourceAbsolute(deps, copy.source.path);
    const finger = await deps.fingerprint(abs, deps.options);
    if (!finger.ok) return hold(deps, record, finger.error, 'blocked');
    if (finger.value.sha256 !== copy.source.sha256 || finger.value.size !== copy.source.size) return hold(deps, record, 'file-changed', 'blocked');
    const mount = deps.mountRoot(copy.pairId);
    if (!mount) return hold(deps, record, 'mount-invalid', 'blocked');
    const root = await checkMountFolder(deps.node, mount);
    if (!root.ok) return hold(deps, record, root.error, 'blocked');
    const placed = await placeFile(deps.node, root.value, abs, copy.destName, { sha256: copy.source.sha256, size: copy.source.size }, deps.options);
    if (!placed.ok) return hold(deps, record, placed.error, 'blocked');
    const next = transition(record, 'copied', deps.now(), { placed: placed.value });
    if (!next.ok) return fail(deps, record, next.error);
    const saved = await save(deps, next.value);
    return saved.ok ? { record: saved.value, waiting: 'none' } : fail(deps, record, saved.error);
}

// ─── Remote capture ─────────────────────────────────────────────────────────

async function captureStage(deps: OffloadDeps, record: OffloadRecord): Promise<AdvanceOutcome> {
    const placed = record.placed;
    if (!placed) return fail(deps, record, 'invalid-transition');
    const listing = await deps.listFolder(record.copy.driveFolderId);
    if (!listing.ok) return hold(deps, record, listing.error, 'blocked');
    const match = matchRemote(listing.value, { name: placed.destName, size: placed.size, sha256: placed.sha256 }, record.copy.driveFolderId);
    if (match.state === 'none') return hold(deps, record, 'drive-not-synced', 'drive-sync');
    if (match.state === 'many') return hold(deps, record, 'remote-ambiguous', 'blocked');
    const next = transition(record, 'remote-captured', deps.now(), { remote: match.remote });
    if (!next.ok) return fail(deps, record, next.error);
    const saved = await save(deps, next.value);
    return saved.ok ? { record: saved.value, waiting: 'rewrite-approval' } : fail(deps, record, saved.error);
}

// ─── Rewrite ────────────────────────────────────────────────────────────────

/** Build the rewrite plan for the Final review step. Persists nothing. */
export async function prepareRewrite(deps: OffloadDeps, record: OffloadRecord): Promise<Result<{ plan: RewritePlan; changed: string[] }>> {
    if (!record.remote) return err('invalid-transition');
    const texts = new Map<string, string>();
    for (const r of record.copy.referrers) {
        const text = await deps.readText(r.path);
        if (text !== null) texts.set(r.path, text);
    }
    return buildRewritePlan(record.copy, record.remote, texts);
}

/** The user approved the rewrite plan: persist it, immutable from here on. */
export async function approveRewrite(deps: OffloadDeps, record: OffloadRecord, plan: RewritePlan, changed: readonly string[]): Promise<Result<OffloadRecord>> {
    const referrers = { ...record.referrers };
    for (const path of changed) referrers[path] = 'skipped';
    const next = transition(record, 'rewrite-approved', deps.now(), { rewrite: plan, referrers });
    if (!next.ok) return err(next.error);
    return save(deps, next.value);
}

async function rewriteStage(deps: OffloadDeps, start: OffloadRecord): Promise<AdvanceOutcome> {
    const plan = start.rewrite;
    if (!plan) return fail(deps, start, 'invalid-transition');
    let record = start;
    if (record.step === 'rewrite-approved') {
        const moved = transition(record, 'rewriting', deps.now());
        if (!moved.ok) return fail(deps, record, moved.error);
        const saved = await save(deps, moved.value);
        if (!saved.ok) return fail(deps, record, saved.error);
        record = saved.value;
    }
    for (const item of plan.items) {
        // A conflict is re-assessed: the user may have fixed the note, or it may already carry the new text.
        if (record.referrers[item.path] !== 'pending' && record.referrers[item.path] !== 'conflict') continue;
        const text = await deps.readText(item.path);
        let status: ReferrerStatus = 'conflict';
        if (text !== null) {
            const hash = await textHash(text);
            if (hash === item.expectedAfterHash) {
                status = 'done'; // already rewritten (an earlier run, or a resume after a crash)
            } else if (hash === item.baselineHash) {
                const written = item.kind === 'canvas'
                    ? await deps.writeCanvas(item.path, item.nodeIds, plan.url, text)
                    : await deps.writeMarkdown(item.path, text, applyEdits(text, item.edits));
                if (written.ok) {
                    // Verify by reading it back.
                    const back = await deps.readText(item.path);
                    status = back !== null && (await textHash(back)) === item.expectedAfterHash ? 'done' : 'conflict';
                }
            }
        }
        record = { ...record, referrers: { ...record.referrers, [item.path]: status }, updatedAt: deps.now() };
        const saved = await save(deps, record);
        if (!saved.ok) return fail(deps, record, saved.error);
    }
    if (plan.items.some((i) => record.referrers[i.path] !== 'done')) return hold(deps, record, 'referrer-conflict', 'blocked');
    const verified = transition(record, 'verified', deps.now());
    if (!verified.ok) return fail(deps, record, verified.error);
    const saved = await save(deps, verified.value);
    return saved.ok ? { record: saved.value, waiting: 'none' } : fail(deps, record, saved.error);
}

// ─── Barrier and trash ──────────────────────────────────────────────────────

async function trashStage(deps: OffloadDeps, start: OffloadRecord): Promise<AdvanceOutcome> {
    let record = start;
    const { copy } = record;
    if (record.step === 'trash-pending' && !deps.exists(copy.source.path)) {
        // The source is gone after trash-pending was recorded: the trash happened.
        return finish(deps, record);
    }
    if (!deps.exists(copy.source.path)) return fail(deps, record, 'source-missing');

    // The vault is watched from the start of the check until the moment the file is trashed, so a
    // reference added while the checkpoint is being saved invalidates the decision too.
    let result: ReturnType<typeof evaluateBarrier> = { ok: false, reason: 'vault-changed' };
    // The identity the barrier itself just verified; the trash is handed this, not the one from planning.
    let verified: { size: number; mtimeMs: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const watch = deps.watch();
        let stopped = false;
        const stop = (): number => { if (stopped) return 0; stopped = true; return watch.stop(); };
        try {
        const finger = await deps.fingerprint(sourceAbsolute(deps, copy.source.path), deps.options);
        verified = finger.ok ? { size: finger.value.size, mtimeMs: finger.value.mtimeMs } : null;
        const listing = await deps.listFolder(copy.driveFolderId);
        const stillThere = listing.ok && record.remote
            ? matchRemote(listing.value, { name: record.remote.name, size: record.remote.size, sha256: record.remote.sha256 }, copy.driveFolderId)
            : null;
        const scan = await deps.scanReferences(copy.source.path);
        const protectedHit = isProtectedPath(deps.protectedFolders(), copy.source.path)
            || copy.referrers.some((r) => isProtectedPath(deps.protectedFolders(), r.path));
        let events = 0;
        result = evaluateBarrier({
            referrers: copy.referrers.map((r) => ({ path: r.path, status: record.referrers[r.path] ?? 'pending' })),
            remoteMatches: stillThere?.state === 'one' && stillThere.remote.id === record.remote?.id,
            sourceMatches: finger.ok && finger.value.sha256 === copy.source.sha256 && finger.value.size === copy.source.size,
            protectionOk: !protectedHit,
            remainingReferences: scan.ok ? scan.value.remaining : 1,
            coverageFailures: scan.ok ? scan.value.coverageFailures : 1,
            unaccountedEvents: 0,
        });
        if (result.ok && record.step === 'verified') {
            const pending = transition(record, 'trash-pending', deps.now());
            if (!pending.ok) return fail(deps, record, pending.error);
            const saved = await save(deps, pending.value);
            if (!saved.ok) return fail(deps, record, saved.error);
            record = saved.value;
        }
        events = stop();
        // An event during the check or the checkpoint invalidates the decision; look again.
        if (events > 0) { result = { ok: false, reason: 'vault-changed' }; continue; }
        if (!result.ok) break;
        break;
        } finally {
            stop(); // released on every exit, including a dependency that throws
        }
    }
    if (!result.ok) return hold(deps, record, barrierCode(result.reason), 'blocked');

    if (!verified) return hold(deps, record, 'file-changed', 'blocked');
    const trashed = await deps.trash(copy.source.path, verified);
    // Whatever the trash reported, only the vault decides: the file must really be gone.
    if (deps.exists(copy.source.path)) return hold(deps, record, trashed.ok ? 'trash-failed' : trashed.error, 'blocked');
    return finish(deps, record);
}

function barrierCode(reason: BarrierReason): string {
    return `barrier-${reason}`;
}

async function finish(deps: OffloadDeps, record: OffloadRecord): Promise<AdvanceOutcome> {
    let current = record;
    for (const step of ['trashed', 'done'] as const) {
        if (current.step === step) continue;
        const moved = transition(current, step, deps.now(), { blocked: undefined });
        if (!moved.ok) return fail(deps, current, moved.error);
        const saved = await save(deps, moved.value);
        // The file is already gone. A failed checkpoint is not a failed offload: keep the last saved
        // step (trash-pending) so a resume sees the source missing and completes this step.
        if (!saved.ok) return { record: current, waiting: 'blocked', persistError: saved.error };
        current = saved.value;
    }
    return { record: current, waiting: 'done' };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

/**
 * Run the operation as far as it can go without the user: copy, then remote capture, then stop for
 * the rewrite approval. After the approval, `continueOffload` does the rewrite, the barrier and the trash.
 */
export async function advanceOffload(deps: OffloadDeps, record: OffloadRecord): Promise<AdvanceOutcome> {
    let current = record;
    try {
        if (isTerminal(current.step)) return { record: current, waiting: current.step === 'done' ? 'done' : 'blocked' };
        if (current.step === 'planned') {
            const out = await copyStage(deps, current);
            if (out.record.step !== 'copied') return out;
            current = out.record;
        }
        if (current.step === 'copied') {
            const out = await captureStage(deps, current);
            if (out.record.step !== 'remote-captured') return out;
            current = out.record;
        }
        if (current.step === 'remote-captured') return { record: current, waiting: 'rewrite-approval' };
        return continueOffload(deps, current);
    } catch {
        return fail(deps, current, 'write-failed');
    }
}

/** After the rewrite approval (or when resuming past it): rewrite, check the barrier, trash. */
export async function continueOffload(deps: OffloadDeps, record: OffloadRecord): Promise<AdvanceOutcome> {
    let current = record;
    try {
        if (current.step === 'rewrite-approved' || current.step === 'rewriting') {
            const out = await rewriteStage(deps, current);
            if (out.record.step !== 'verified') return out;
            current = out.record;
        }
        if (current.step === 'verified' || current.step === 'trash-pending') return await trashStage(deps, current);
        if (current.step === 'trashed') return finish(deps, current);
        return { record: current, waiting: current.step === 'done' ? 'done' : 'none' };
    } catch {
        return fail(deps, current, 'write-failed');
    }
}

/** Abandon the operation. Allowed only before any reference was rewritten. */
export async function abortOffload(deps: OffloadDeps, record: OffloadRecord): Promise<Result<OffloadRecord>> {
    const next = transition(record, 'aborted', deps.now());
    if (!next.ok) return err('invalid-transition');
    return save(deps, next.value);
}
