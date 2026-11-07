/**
 * The live pack service: consent (review, confirm, turn off), publication (refresh) and revocation, all through ONE queue.
 *
 *  - Consent lives in the workspace record (`live`); status is only status (`aiWorkspaceLiveStatus`).
 *  - Every job captures the authorization epoch when it starts and checks it again, with the approval, the policy revision and the
 *    source hashes, immediately before the file is touched. Any settings save or consent change bumps the epoch synchronously.
 *  - A revocation is persisted before an approval is cleared and removed only after the stub is written and read back.
 *  - Only the installation recorded in the approval writes. Others show status and can request a turn-off.
 *
 * The environment (settings, saves, the notes, Node modules, the device id) is injected, so the service is tested without Obsidian.
 */
import type { AIOrganiserSettings } from '../../core/settings';
import { Result, ok, err, type BatchResult } from '../../core/result';
import { logger } from '../../utils/logger';
import type { PackInput } from './contextPack';
import { packSha256 } from './contextPack';
import { buildLivePack, buildLiveStub, type LiveBuild } from './livePack';
import { checkLiveFolder, liveFileName, verifyLiveFile, writeLiveFile, type IntentJournal, type LiveDeps, type LiveTarget } from './liveFileWriter';
import type { LiveStatus } from './liveStatus';
import { stripWorkspaceBlock } from './workspaceBlock';
import type { PackNotes } from './workspaceService';
import { normaliseWorkspace, type LiveApproval, type PendingRevocation, type WorkspaceRecord } from './workspaceRecord';

export interface LiveEnv {
    settings(): AIOrganiserSettings;
    /** Persist a consent change (the full settings save) */
    saveConsent(): Promise<void>;
    /** Persist status or revocation bookkeeping without re-initialising services */
    saveStatus(): Promise<void>;
    featureOn(): boolean;
    collectNotes(aioId: string): Promise<Result<PackNotes>>;
    packInput(aioId: string, notes: PackNotes): Promise<PackInput>;
    sharePolicy(): Promise<string>;
    deviceId(): string;
    deps(): LiveDeps | null;
    vaultBase(): string | null;
    journal: IntentJournal;
    now(): Date;
}

export interface CandidateNote {
    path: string;
    shareable: boolean;
    reason: string | null;
    approved: boolean;
    hash: string;
}

export interface CandidateSnapshot {
    aioId: string;
    /** Monotonic per project: an older snapshot never replaces a newer one */
    revision: number;
    generation: number;
    projectPath: string;
    areaPath: string | null;
    contextSources: string[];
    notes: CandidateNote[];
}

export interface LiveReview {
    aioId: string;
    projectName: string;
    folder: string;
    fileName: string;
    /** The approval generation and owner the review was opened under (0 / null = none yet) */
    generation: number;
    owner: string | null;
    policy: string;
    snapshot: CandidateSnapshot;
}

export interface SelectionPreview {
    ticked: string[];
    digest: string;
    bytes: number;
    held: string[];
    skipped: Array<{ path: string; reason: string }>;
}

export type RefreshKind = 'written' | 'unchanged' | 'held' | 'revoked' | 'needs-review';
export interface RefreshOutcome {
    kind: RefreshKind;
    snapshot: CandidateSnapshot | null;
}

export type RevokeCause = 'turn-off' | 'scope-lost' | 'feature-off';

const norm = (p: string): string => p.replace(/\\/g, '/');

export class LivePackService {
    private epoch = 0;
    private tail: Promise<unknown> = Promise.resolve();
    private readonly queued = new Map<string, Promise<Result<RefreshOutcome>>>();
    private readonly revisions = new Map<string, number>();
    private readonly applied = new Map<string, number>();
    /** Set by the scheduler: receives every snapshot, newest only */
    onSnapshot: ((snapshot: CandidateSnapshot) => void) | null = null;
    /** Set by the scheduler: a write was withdrawn because something changed; try again after the quiet time */
    onRetry: ((aioId: string) => void) | null = null;

    private closed = false;

    constructor(private readonly env: LiveEnv) {}

    /** The plugin is unloading or the feature was turned off: no new or queued publication may write. Revocations still run. */
    close(): void {
        this.closed = true;
        this.bumpEpoch();
    }

    /** Any change that could change what may be shared. Synchronous: queued jobs see it before they write. */
    bumpEpoch(): void {
        this.epoch++;
    }

    private run<T>(job: () => Promise<T>): Promise<T> {
        const next = this.tail.then(job, job);
        this.tail = next.catch(() => undefined);
        return next;
    }

    private record(aioId: string): WorkspaceRecord | null {
        return normaliseWorkspace(this.env.settings().aiWorkspaces[aioId]);
    }

    private status(aioId: string): LiveStatus {
        return this.env.settings().aiWorkspaceLiveStatus[aioId] ?? { state: 'off', held: [] };
    }

    private async setStatus(aioId: string, patch: Partial<LiveStatus>): Promise<void> {
        const s = this.env.settings();
        s.aiWorkspaceLiveStatus = { ...s.aiWorkspaceLiveStatus, [aioId]: { ...this.status(aioId), ...patch } };
        try { await this.env.saveStatus(); } catch (e) { logger.warn('AiWorkspaces', 'Could not save the live pack status', e); }
    }

    private async fail(aioId: string, code: string): Promise<Result<RefreshOutcome>> {
        await this.setStatus(aioId, { state: code === 'live-other-device' ? 'other-device' : code === 'live-needs-review' ? 'needs-review' : 'error', lastError: code });
        return err(code);
    }

    private deliver(snapshot: CandidateSnapshot): void {
        if ((this.applied.get(snapshot.aioId) ?? 0) >= snapshot.revision) return;
        this.applied.set(snapshot.aioId, snapshot.revision);
        try { this.onSnapshot?.(snapshot); } catch (e) { logger.warn('AiWorkspaces', 'Could not update the live pack watch list', e); }
    }

    /** The one reader of candidates: project note, Area note, context sources, each with shareability, approval and hash. */
    async collectCandidates(aioId: string): Promise<Result<{ snapshot: CandidateSnapshot; notes: PackNotes; input: PackInput }>> {
        try {
            return await this.collectCandidatesUnsafe(aioId);
        } catch (e) {
            logger.error('AiWorkspaces', 'Could not read the live pack sources', e);
            return err('project-not-found');
        }
    }

    /** Run a job in the live pack queue (for settings applied from another device, so they never interleave with a consent change). */
    enqueue<T>(job: () => Promise<T>): Promise<T> {
        return this.run(job);
    }

    private async collectCandidatesUnsafe(aioId: string): Promise<Result<{ snapshot: CandidateSnapshot; notes: PackNotes; input: PackInput }>> {
        const revision = (this.revisions.get(aioId) ?? 0) + 1;
        this.revisions.set(aioId, revision);
        const notes = await this.env.collectNotes(aioId);
        if (!notes.ok) return err(notes.error);
        const input = await this.env.packInput(aioId, notes.value);
        const live = notes.value.record.live;
        const approved = new Set((live?.approvedSources ?? []).map(norm));
        const all = [notes.value.project, ...(notes.value.area ? [notes.value.area] : []), ...notes.value.sources];
        const out: CandidateNote[] = [];
        for (const n of all) {
            if (out.some((o) => o.path === n.path)) continue;
            const reason = input.reasonNotShareable(n.path);
            out.push({ path: n.path, shareable: reason === null, reason, approved: approved.has(norm(n.path)), hash: await packSha256(stripWorkspaceBlock(n.text)) });
        }
        const snapshot: CandidateSnapshot = {
            aioId, revision, generation: live?.generation ?? 0, projectPath: notes.value.project.path, areaPath: notes.value.area?.path ?? null,
            contextSources: notes.value.record.contextSources, notes: out,
        };
        return ok({ snapshot, notes: notes.value, input });
    }

    /** Re-collect one project's candidates now (a project note changed) and hand the snapshot to the watcher. */
    async recollect(aioId: string): Promise<void> {
        try {
            const c = await this.collectCandidates(aioId);
            if (c.ok) this.deliver(c.value.snapshot);
        } catch (e) {
            logger.warn('AiWorkspaces', 'Could not re-read the live pack sources', e);
        }
    }

    private gate(): Result<LiveDeps> {
        if (this.closed || !this.env.featureOn()) return err('unknown');
        const deps = this.env.deps();
        return deps ? ok(deps) : err('live-desktop-only');
    }

    private pendingFor(aioId: string): PendingRevocation | undefined {
        return this.env.settings().aiWorkspaceLiveRevocations.find((r) => r.aioId === aioId);
    }

    /** What the review shows: candidates only (the selected bytes come from `previewSelection`). */
    async prepareReview(aioId: string): Promise<Result<LiveReview>> {
        try {
            const gate = this.gate();
            if (!gate.ok) return err(gate.error);
            const record = this.record(aioId);
            const live = record?.live;
            if (live && live.deviceId !== this.env.deviceId()) return err('live-other-device');
            if (this.pendingFor(aioId)) return err('live-other-device');
            const c = await this.collectCandidates(aioId);
            if (!c.ok) return err(c.error);
            const projectName = c.value.input.projectName;
            let folder = live?.folder;
            let fileName = live?.fileName;
            if (!folder || !fileName) {
                const checked = await checkLiveFolder(gate.value, this.env.settings().aiWorkspaceLiveFolder, this.env.vaultBase());
                if (!checked.ok) return err(checked.error);
                const name = liveFileName(projectName);
                if (!name.ok) return err(name.error);
                folder = checked.value;
                fileName = name.value;
            }
            this.deliver(c.value.snapshot);
            return ok({ aioId, projectName, folder, fileName, generation: live?.generation ?? 0, owner: live?.deviceId ?? null, policy: c.value.input.sharePolicyRevision, snapshot: c.value.snapshot });
        } catch (e) {
            logger.error('AiWorkspaces', 'Could not prepare the live pack review', e);
            return err('unknown');
        }
    }

    private async build(input: PackInput, approved: readonly string[], fileName: string): Promise<Result<LiveBuild>> {
        return buildLivePack({ ...input, approved, livePackName: fileName, updatedAt: this.env.now().toISOString() });
    }

    /** The exact live output for a selection (the review calls this on every tick change). */
    async previewSelection(review: LiveReview, ticked: readonly string[]): Promise<Result<SelectionPreview>> {
        try {
            if (!ticked.map(norm).includes(norm(review.snapshot.projectPath))) return err('live-needs-review');
            const c = await this.collectCandidates(review.aioId);
            if (!c.ok) return err(c.error);
            const built = await this.build(c.value.input, ticked, review.fileName);
            if (!built.ok) return err(built.error);
            if (built.value.kind !== 'pack') return err(built.value.kind === 'revoke' ? 'pack-preview-stale' : 'live-needs-review');
            return ok({ ticked: [...ticked], digest: built.value.digest, bytes: built.value.bytes, held: built.value.held, skipped: built.value.skipped });
        } catch (e) {
            logger.error('AiWorkspaces', 'Could not preview the live pack', e);
            return err('unknown');
        }
    }

    /** Record the approval of exactly the previewed selection, then publish it. Refused when anything it was based on changed. */
    confirm(review: LiveReview, preview: SelectionPreview): Promise<Result<RefreshOutcome>> {
        return this.run(async () => {
            try {
                const gate = this.gate();
                if (!gate.ok) return err(gate.error);
                const record = this.record(review.aioId);
                if (!record) return err('project-not-found');
                const live = record.live;
                if ((live?.generation ?? 0) !== review.generation || (live?.deviceId ?? null) !== review.owner || this.pendingFor(review.aioId)) return err('pack-preview-stale');
                const c = await this.collectCandidates(review.aioId);
                if (!c.ok) return err(c.error);
                if (c.value.input.sharePolicyRevision !== review.policy) return err('pack-preview-stale');
                const ticked = new Set(preview.ticked.map(norm));
                for (const n of review.snapshot.notes) {
                    if (!ticked.has(norm(n.path))) continue;
                    const now = c.value.snapshot.notes.find((x) => x.path === n.path);
                    if (!now || !now.shareable || now.hash !== n.hash) return err('pack-preview-stale');
                }
                const built = await this.build(c.value.input, preview.ticked, review.fileName);
                if (!built.ok) return err(built.error);
                if (built.value.kind !== 'pack' || built.value.digest !== preview.digest) return err('pack-preview-stale');
                const approval: LiveApproval = {
                    approvedSources: [c.value.snapshot.projectPath, ...preview.ticked.filter((p) => norm(p) !== norm(c.value.snapshot.projectPath))],
                    approvedPolicy: review.policy,
                    approvedAt: this.env.now().toISOString(),
                    deviceId: this.env.deviceId(),
                    folder: review.folder,
                    fileName: review.fileName,
                    generation: (live?.generation ?? 0) + 1,
                };
                // Checked again with no await before the install: a turn-off (recorded synchronously) while this ran wins.
                const current = this.record(review.aioId);
                if (!current || (current.live?.generation ?? 0) !== review.generation || (current.live?.deviceId ?? null) !== review.owner || this.pendingFor(review.aioId)) return err('pack-preview-stale');
                const s = this.env.settings();
                s.aiWorkspaces = { ...s.aiWorkspaces, [review.aioId]: { ...current, live: approval } };
                this.bumpEpoch();
                try {
                    await this.env.saveConsent();
                } catch (e) {
                    // Not saved = not approved: the previous state comes back, unless something newer replaced this approval meanwhile.
                    logger.error('AiWorkspaces', 'Could not save the live pack approval', e);
                    if (this.record(review.aioId)?.live?.generation === approval.generation) s.aiWorkspaces = { ...s.aiWorkspaces, [review.aioId]: current };
                    this.bumpEpoch();
                    return err('unknown');
                }
                return await this.publish(review.aioId, true, this.epoch);
            } catch (e) {
                logger.error('AiWorkspaces', 'Could not turn on the live pack', e);
                return err('unknown');
            }
        });
    }

    /** Rebuild and, if anything changed, write. Requests for a project already waiting are coalesced. */
    refresh(aioId: string, opts: { force?: boolean } = {}): Promise<Result<RefreshOutcome>> {
        const waiting = this.queued.get(aioId);
        if (waiting && !opts.force) return waiting;
        const job = this.run(async () => {
            this.queued.delete(aioId);
            try {
                return await this.publish(aioId, opts.force === true, this.epoch);
            } catch (e) {
                logger.error('AiWorkspaces', 'Could not refresh the live pack', e);
                return this.fail(aioId, 'live-write-failed');
            }
        });
        if (!opts.force) this.queued.set(aioId, job);
        return job;
    }

    private target(aioId: string, live: Pick<LiveApproval, 'folder' | 'fileName' | 'generation'>): LiveTarget {
        return { folder: live.folder, fileName: live.fileName, aioId, generation: live.generation };
    }

    /** Runs inside the queue. */
    private async publish(aioId: string, force: boolean, startEpoch: number): Promise<Result<RefreshOutcome>> {
        const gate = this.gate();
        if (!gate.ok) return err(gate.error);
        const deps = gate.value;
        const live = this.record(aioId)?.live;
        // Turned off since this was asked for: nothing to do, and the status ("off") stays as the turn-off left it.
        if (!live) return err('live-not-on');
        if (live.deviceId !== this.env.deviceId()) return this.fail(aioId, 'live-other-device');
        if (this.pendingFor(aioId)) {
            const done = await this.processRevocations();
            const failed = done.errors.find((e) => e.source === aioId);
            return failed ? err(failed.error) : ok({ kind: 'revoked', snapshot: null });
        }
        const c = await this.collectCandidates(aioId);
        if (!c.ok) {
            // The notes could not be read. Shareability changes only with the share policy: if that changed too, nothing proves the
            // approved notes may still be shared, so the file is withdrawn. Otherwise the last approved file stays and the error shows.
            let policy: string | null = null;
            try { policy = await this.env.sharePolicy(); } catch (e) { logger.warn('AiWorkspaces', 'Could not read the share policy', e); }
            if (policy !== live.approvedPolicy) { const r = await this.revokeNow(aioId, 'scope-lost'); return r.ok ? ok({ kind: 'revoked', snapshot: null }) : err(r.error); }
            return this.fail(aioId, c.error);
        }
        const snapshot = c.value.snapshot;
        this.deliver(snapshot);
        // The share policy changed since the approval: stop, and withdraw if an approved note may no longer be shared.
        if (c.value.input.sharePolicyRevision !== live.approvedPolicy) {
            const lost = snapshot.notes.some((n) => n.approved && !n.shareable) || live.approvedSources.some((p) => !snapshot.notes.some((n) => norm(n.path) === norm(p)) && c.value.input.reasonNotShareable(p) !== null);
            if (lost) { const r = await this.revokeNow(aioId, 'scope-lost'); return r.ok ? ok({ kind: 'revoked', snapshot }) : err(r.error); }
            await this.setStatus(aioId, { state: 'needs-review', held: snapshot.notes.filter((n) => n.shareable && !n.approved).map((n) => n.path) });
            return ok({ kind: 'needs-review', snapshot });
        }
        const built = await this.build(c.value.input, live.approvedSources, live.fileName);
        if (!built.ok) return this.fail(aioId, built.error);
        if (built.value.kind === 'revoke') { const r = await this.revokeNow(aioId, 'scope-lost'); return r.ok ? ok({ kind: 'revoked', snapshot }) : err(r.error); }
        if (built.value.kind === 'needs-review') {
            await this.setStatus(aioId, { state: 'needs-review', held: snapshot.notes.filter((n) => n.shareable && !n.approved).map((n) => n.path) });
            return ok({ kind: 'needs-review', snapshot });
        }
        const pack = built.value;
        const status = this.status(aioId);
        const target = this.target(aioId, live);
        // Unchanged only when the file there is ours and exactly what was last written.
        if (!force && pack.digest === status.lastDigest && status.lastFileSha) {
            const v = await verifyLiveFile(deps, this.env.journal, target, status.lastFileSha, this.env.vaultBase());
            if (!v.ok) return this.fail(aioId, v.error);
            if (v.value === 'match') {
                await this.setStatus(aioId, { state: 'live', held: pack.held, lastError: undefined });
                return ok({ kind: pack.held.length > 0 ? 'held' : 'unchanged', snapshot });
            }
        }
        const hashes = new Map(snapshot.notes.map((n) => [n.path, n.hash]));
        const authorized = async (): Promise<boolean> => {
            if (this.epoch !== startEpoch) return false;
            const now = this.record(aioId)?.live;
            if (!now || now.generation !== live.generation || now.deviceId !== live.deviceId || now.folder !== live.folder || now.fileName !== live.fileName) return false;
            if (this.pendingFor(aioId)) return false;
            if ((await this.env.sharePolicy()) !== live.approvedPolicy) return false;
            const fresh = await this.env.collectNotes(aioId);
            if (!fresh.ok) return false;
            // From the built output to the notes now: every note in the pack must still be there, still a source, unchanged.
            const now2 = new Map([fresh.value.project, ...(fresh.value.area ? [fresh.value.area] : []), ...fresh.value.sources].map((n) => [n.path, n.text]));
            for (const src of pack.sources) {
                const text = now2.get(src.path);
                if (text === undefined || hashes.get(src.path) !== (await packSha256(stripWorkspaceBlock(text)))) return false;
            }
            return this.epoch === startEpoch && !this.closed;
        };
        const written = await writeLiveFile(deps, this.env.journal, target, pack.text, this.env.vaultBase(), authorized);
        if (!written.ok) {
            if (written.error === 'live-needs-review') {
                // Something changed between the build and the write: nothing was written. The watcher waits its quiet time
                // and tries again (a policy change has its own immediate check), so a busy note never spins rebuilds.
                try { this.onRetry?.(aioId); } catch (e) { logger.warn('AiWorkspaces', 'Could not schedule the live pack again', e); }
                return ok({ kind: 'needs-review', snapshot });
            }
            return this.fail(aioId, written.error);
        }
        await this.setStatus(aioId, { state: 'live', lastWrittenAt: this.env.now().toISOString(), lastDigest: pack.digest, lastFileSha: written.value.fileSha, held: pack.held, lastError: undefined });
        return ok({ kind: pack.held.length > 0 ? 'held' : 'written', snapshot });
    }

    /** Persist the revocation (and clear the approval when the cause ends it), then write the stub. Inside the queue. */
    private async revokeNow(aioId: string, cause: RevokeCause): Promise<Result<true>> {
        this.persistRevocation(aioId, cause);
        // The stub is written even when the request could not be saved: stopping the sharing comes first. The failure is reported.
        const saved = await this.saveRevocations();
        const done = await this.processRevocations();
        const failed = done.errors.find((e) => e.source === aioId);
        if (failed) return err(failed.error);
        return saved ? ok(true) : err('live-revocation-unsaved');
    }

    /** Persist the pending revocations; false when the save failed (the caller reports it). */
    private async saveRevocations(): Promise<boolean> {
        try { await this.env.saveStatus(); return true; } catch (e) { logger.error('AiWorkspaces', 'Could not save the live pack revocations', e); return false; }
    }

    private persistRevocation(aioId: string, cause: RevokeCause): void {
        const s = this.env.settings();
        const record = this.record(aioId);
        const live = record?.live;
        if (!record || !live) return;
        if (!s.aiWorkspaceLiveRevocations.some((r) => r.aioId === aioId && r.folder === live.folder && r.fileName === live.fileName)) {
            s.aiWorkspaceLiveRevocations = [...s.aiWorkspaceLiveRevocations, {
                aioId, deviceId: live.deviceId, folder: live.folder, fileName: live.fileName,
                projectName: live.fileName.replace(/ - live pack\.md$/, ''), requestedAt: this.env.now().toISOString(),
            }];
        }
        // Scope loss keeps the approval (paused for review); turning off ends it.
        if (cause !== 'scope-lost') {
            const ended: WorkspaceRecord = { ...record };
            delete ended.live;
            s.aiWorkspaces = { ...s.aiWorkspaces, [aioId]: ended };
        }
        s.aiWorkspaceLiveStatus = { ...s.aiWorkspaceLiveStatus, [aioId]: { ...this.status(aioId), state: 'revoking' } };
        this.bumpEpoch();
    }

    /** Turn the live pack off for one project: the file becomes the "no longer shared" stub (on the computer that writes it). */
    turnOff(aioId: string): Promise<Result<'stubbed' | 'requested'>> {
        // The intent is recorded at once, outside the queue: a refresh already waiting must see it.
        const live = this.record(aioId)?.live;
        if (!live) return Promise.resolve(err('live-not-on'));
        this.persistRevocation(aioId, 'turn-off');
        const owner = live.deviceId === this.env.deviceId();
        return this.run(async () => {
            let saved = true;
            try { await this.env.saveConsent(); } catch (e) { logger.error('AiWorkspaces', 'Could not save turning off the live pack', e); saved = false; }
            if (!owner || !this.env.deps()) {
                await this.setStatus(aioId, { state: 'other-device' });
                return saved ? ok('requested' as const) : err('live-revocation-unsaved');
            }
            // The stub is written even when the request could not be saved: stopping the sharing comes first.
            const res = await this.processRevocations();
            const failed = res.errors.find((e) => e.source === aioId);
            if (failed) return err(failed.error);
            return saved ? ok('stubbed' as const) : err('live-revocation-unsaved');
        });
    }

    /** Every publication owned here becomes a pending revocation (synchronous), then the stubs are written in the queue. */
    revokeAll(cause: RevokeCause): Promise<BatchResult<string>> {
        // Every live pack, whoever writes it: the computer that writes one carries out the request when it next runs.
        const ids = Object.keys(this.env.settings().aiWorkspaces).filter((id) => !!this.record(id)?.live);
        for (const id of ids) this.persistRevocation(id, cause);
        return this.run(async () => {
            const saved = await this.saveRevocations();
            const res = await this.processRevocations();
            if (!saved) {
                for (const id of ids) if (!res.errors.some((e) => e.source === id)) res.errors.push({ source: id, error: 'live-revocation-unsaved' });
                res.isPartial = res.items.length > 0 && res.errors.length > 0;
            }
            return res;
        });
    }

    /**
     * Write the stub for every pending revocation owned by this installation, and resolve interrupted writes. Runs with the feature
     * on or off (desktop only): it only ever writes stubs.
     */
    reconcile(): Promise<BatchResult<string>> {
        return this.run(() => this.processRevocations(true));
    }

    private async processRevocations(withIntents = false): Promise<BatchResult<string>> {
        const result: BatchResult<string> = { items: [], errors: [], warnings: [], isPartial: false };
        const deps = this.env.deps();
        if (!deps) return result;
        const s = this.env.settings();
        const mine = s.aiWorkspaceLiveRevocations.filter((r) => r.deviceId === this.env.deviceId());
        for (const r of mine) {
            const target: LiveTarget = { folder: r.folder, fileName: r.fileName, aioId: r.aioId, generation: -1 };
            const stub = buildLiveStub(r.fileName, r.aioId, this.env.now().toISOString());
            // A file that is not there needs no stub; one there that is not ours is never touched.
            const present = await verifyLiveFile(deps, this.env.journal, target, '', this.env.vaultBase());
            const res = present.ok && present.value === 'missing' ? ok(null) : await writeLiveFile(deps, this.env.journal, target, stub, this.env.vaultBase());
            if (res.ok) {
                s.aiWorkspaceLiveRevocations = s.aiWorkspaceLiveRevocations.filter((x) => x !== r && !(x.aioId === r.aioId && x.deviceId === r.deviceId && x.folder === r.folder && x.fileName === r.fileName));
                const still = this.record(r.aioId)?.live;
                s.aiWorkspaceLiveStatus = { ...s.aiWorkspaceLiveStatus, [r.aioId]: { ...this.status(r.aioId), state: still ? 'needs-review' : 'off', lastDigest: undefined, lastFileSha: undefined, lastError: undefined } };
                result.items.push(r.aioId);
            } else {
                result.errors.push({ source: r.aioId, error: res.error });
                s.aiWorkspaceLiveStatus = { ...s.aiWorkspaceLiveStatus, [r.aioId]: { ...this.status(r.aioId), state: 'revoking', lastError: res.error } };
            }
        }
        if (withIntents) {
            for (const [, intent] of this.env.journal.all()) {
                const live = this.record(intent.aioId)?.live;
                // An interrupted write of a project still on: regenerate under the current consent (the feature must be on).
                if (live && live.deviceId === this.env.deviceId() && this.env.featureOn()) void this.refresh(intent.aioId, { force: true });
            }
        }
        result.isPartial = result.items.length > 0 && result.errors.length > 0;
        // Nothing pending (every start-up of everyone who never used the live pack): nothing is saved.
        if (mine.length > 0 && !(await this.saveRevocations())) result.warnings.push('live-revocation-unsaved');
        return result;
    }

    /** After any settings save: re-check every live project here against the current policy (no build when it still matches). */
    checkPolicyAll(): void {
        const ids = Object.keys(this.env.settings().aiWorkspaces).filter((id) => this.record(id)?.live?.deviceId === this.env.deviceId());
        void this.run(async () => {
            let policy: string;
            try {
                policy = await this.env.sharePolicy();
            } catch (e) {
                // The policy cannot be read: every live pack here is checked by a refresh, which withdraws when it cannot prove sharing.
                logger.warn('AiWorkspaces', 'Could not read the share policy for the live packs', e);
                for (const id of ids) void this.refresh(id);
                return;
            }
            for (const id of ids) {
                const live = this.record(id)?.live;
                if (live && live.approvedPolicy !== policy) void this.refresh(id);
            }
        });
    }

    /** The projects with a live pack written by this installation. */
    ownedProjects(): string[] {
        return Object.keys(this.env.settings().aiWorkspaces).filter((id) => this.record(id)?.live?.deviceId === this.env.deviceId());
    }
}
