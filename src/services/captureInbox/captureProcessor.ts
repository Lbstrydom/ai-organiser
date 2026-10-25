/**
 * Turns scanned captures into reviewable proposals. One job at a time, journal first.
 *
 * Privacy order inside a job (every step can end the job as `skipped`, and nothing earlier than the
 * failing step has left the machine):
 *   guard (paths, text) -> text-first plan -> read bytes once -> signature + size -> guard again ->
 *   provider call -> guard the MACHINE text -> persist -> classify (guarded text only).
 *
 * Nothing here writes to a note: results wait in the journal until the user accepts (captureWriter).
 */
import type { LanguageCode } from '../types';
import type { PromptParts } from '../prompts/promptParts';
import { Result } from '../../core/result';
import { sha256Hex } from '../attachmentDuplicateService';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { rankByTitleOverlap } from '../attachmentHomeService';
import { exclusionReason, policyRevisionOf, type SweepPolicy } from '../inboxSweep/sweepGuard';
import { buildCaptureClassifyPrompt, buildCaptureFolderContext, parseProposal, type RawProposal } from './captureClassify';
import { bump, bumpBucket, canStartProcessing, finish, getEntry, upsertEntry } from './captureJournal';
import { findCaptureBlock } from './enrichmentBlock';
import { readCaptureId } from './frontmatterKey';
import { checkSignature, extensionOf } from './mediaSignature';
import { machineTextExclusion, pathExclusion } from './capturePolicy';
import { CAPTURE_FILE_MISSING, type ScanOutcome, type ScannedCapture, type CaptureVaultPort } from './captureScanner';
import { assess, observationsChanged, type StatResult } from './stabilityTracker';
import { planSources, usableText, userText } from './textFirst';
import type { JournalAccess } from './captureWriter';
import {
    MAX_ATTEMPTS,
    MAX_HELD_CHARS,
    PROCESSING_VERSION,
    type CaptureAttachmentRef,
    type CaptureConfig,
    type CaptureEntry,
    type CaptureJournal,
    type CaptureStage,
    type SkipReason,
} from './captureTypes';

/** Bytes and stats; the production port wraps the vault adapter. */
export interface ProcessorPort {
    /** err = the file cannot be read right now (gone, or the read failed). */
    readBytes(path: string): Promise<Result<Uint8Array>>;
    stat(path: string): Promise<StatResult>;
    exists(path: string): boolean;
}

/** Everything the processor needs from the plugin, injected so it compiles and tests alone. */
export interface CaptureDeps {
    journal: JournalAccess & { mutateLazy(fn: (j: CaptureJournal) => CaptureJournal): Result<void> };
    config(): CaptureConfig;
    /** The BASE sweep policy (never the held-paths one) */
    policy(): SweepPolicy;
    port: ProcessorPort;
    vault: CaptureVaultPort;
    isSwept(path: string, text: string): Promise<boolean>;
    isEnabled(): boolean;
    now(): number;
    digitisationEnabled(): boolean;
    transcribe(bytes: Uint8Array, fileName: string, extension: string): Promise<Result<string>>;
    /** Read an image from bytes the processor already validated (never from the path again). */
    digitise(bytes: Uint8Array, fileName: string, extension: string): Promise<Result<string>>;
    classify(parts: PromptParts): Promise<Result<RawProposal>>;
    taxonomyPrompt(): string | Promise<string>;
    language(): LanguageCode | 'default';
    maxTags(): number;
    formatTags(tags: unknown[]): string[];
    /** Every folder path in the vault (the processor narrows it to the destination root) */
    listFolders(): string[];
    /** False for a protected folder, a kept-out folder or a plugin output root */
    folderAllowed(path: string): boolean;
}

export interface RunControl {
    /** True once the user cancelled the run (checked between jobs and stages) */
    cancelled(): boolean;
}

export interface RunSummary {
    processed: number;
    awaitingReview: number;
    failed: number;
    skipped: number;
    waiting: number;
    /** Processing stopped because the review backlog is full */
    backpressure: boolean;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A capture still missing an attachment after this long is set aside (it would hold the sweep off the note forever). */
export const MISSING_ATTACHMENT_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Errors that retrying cannot fix: do not upload the audio again on every attempt. */
const NON_RETRIABLE_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,20}key|no api key|not configured/i;

function providerFailure(message: string): Error {
    return NON_RETRIABLE_ERROR.test(message) ? new NonRetriable(message) : new Error(message);
}

/** The bytes about to be sent must be the bytes the capture was judged with; a file swapped since the scan drops the job. */
async function assertSameBytes(att: { digest?: string }, bytes: Uint8Array): Promise<void> {
    if (!att.digest || att.digest === 'unreadable') return;
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if ((await sha256Hex(copy)) !== att.digest) throw new Cancelled();
}

/** A stage failure that retrying cannot fix does not consume attempts. */
class NonRetriable extends Error {}
class Cancelled extends Error {}
class Skip extends Error {
    constructor(readonly reason: SkipReason) {
        super(reason);
    }
}

function markerPresent(cap: ScannedCapture, deps: CaptureDeps): boolean {
    if (cap.notePath === null) return deps.port.exists(`${cap.id}.done`);
    if (/^capture-complete:\s*true\s*$/m.test(cap.text.slice(0, 2000))) return true;
    const stem = cap.id.replace(/\.[^./]+$/, '');
    return deps.port.exists(`${cap.id}.done`) || deps.port.exists(`${stem}.done`);
}

function toRefs(cap: ScannedCapture): CaptureAttachmentRef[] {
    return cap.attachments.filter((a) => a.kind !== null).map((a) => ({ path: a.path, size: a.size, digest: a.digest, kind: a.kind as 'audio' | 'image' }));
}

/**
 * Bring the journal in line with what the scan found: create entries, detect edits, and advance
 * `waiting_for_stable` -> `ready` once the note and every attachment have been stable long enough.
 * Decisions use a snapshot, but every change is applied to the LIVE journal and only when the entry
 * has not moved since (a user action or a running job wins over a scan).
 */
export async function syncEntries(deps: CaptureDeps, scan: ScanOutcome, opts: { trustMtime?: boolean } = {}): Promise<void> {
    const config = deps.config();
    const snapshot = deps.journal.get();
    const revision = await policyRevisionOf(deps.policy());
    const now = deps.now();
    const hard: Array<(j: CaptureJournal) => CaptureJournal> = [];
    const lazy: Array<(j: CaptureJournal) => CaptureJournal> = [];

    /** Apply `next` only if the live entry is still what the decision was based on. */
    const unlessMoved = (before: CaptureEntry | undefined, next: CaptureEntry) => (j: CaptureJournal): CaptureJournal => {
        const live = getEntry(j, next.id);
        if ((live?.state ?? null) !== (before?.state ?? null) || (live?.updatedAt ?? 0) !== (before?.updatedAt ?? 0)) return j;
        return upsertEntry(j, next);
    };

    for (const skip of scan.skipped) {
        const held = getEntry(snapshot, skip.id);
        if (held) {
            // A kept-out rule that now covers a held capture drops its text at once: nothing excluded stays in data.json.
            if (skip.reason === 'excluded' && !['processing', 'accept_pending_write', 'accepted', 'organised'].includes(held.state)) {
                hard.push((j) => {
                    const live = getEntry(j, skip.id);
                    if (!live || ['processing', 'accept_pending_write', 'accepted', 'organised'].includes(live.state)) return j;
                    return finish(bumpBucket(upsertEntry(j, { ...live, text: undefined, noteText: undefined, proposal: undefined }), 'skipped', 'excluded'), skip.id, 'skipped', now, revision);
                });
            }
            continue;
        }
        const tomb = snapshot.tombstones[skip.id];
        if (tomb && tomb.state === 'skipped' && tomb.policyRevision === revision) continue;
        // Counted once per policy revision, never held, never written.
        hard.push((j) => finish(bumpBucket(upsertEntry(j, newEntry(skip.id, '', now, { state: 'skipped', skipReason: skip.reason })), 'skipped', skip.reason), skip.id, 'skipped', now, revision));
    }

    for (const cap of scan.captures) {
        const entry = getEntry(snapshot, cap.id);
        if (entry && (entry.state === 'processing' || entry.state === 'accept_pending_write')) continue;

        const stats: Record<string, StatResult> = {};
        if (cap.notePath !== null) stats[cap.notePath] = await deps.port.stat(cap.notePath);
        for (const a of cap.attachments) stats[a.path] = await deps.port.stat(a.path);
        for (const name of cap.missingAttachments) stats[`missing:${name}`] = null;
        const outcome = assess(entry?.observed, stats, now, config.stabilityMs, opts.trustMtime ?? true);
        // A note that waits for an attachment that never arrives would hold the sweep off it forever.
        if (entry && outcome.verdict.kind === 'waiting' && outcome.verdict.reason === 'missing' && now - entry.createdAt > MISSING_ATTACHMENT_GIVE_UP_MS) {
            hard.push((j) => {
                const live = getEntry(j, cap.id);
                if (!live || live.state === 'processing' || live.state === 'accept_pending_write') return j;
                return finish(bumpBucket(upsertEntry(j, { ...live, text: undefined, noteText: undefined, proposal: undefined }), 'skipped', 'attachment-missing'), cap.id, 'skipped', now);
            });
            continue;
        }
        const stable = outcome.verdict.kind === 'ready' && (!config.requireMarker || markerPresent(cap, deps));
        const attachments = toRefs(cap);

        if (!entry) {
            hard.push(unlessMoved(undefined, newEntry(cap.id, cap.fingerprint, now, {
                state: stable ? 'ready' : 'waiting_for_stable', attachments, hasNote: cap.notePath !== null, observed: outcome.observed,
            })));
            continue;
        }

        if (entry.fingerprint !== cap.fingerprint) {
            // Edited while queued, reviewing or failed: results are dropped and stability starts over.
            // A capture that was being reviewed is never re-processed (and re-charged) without asking.
            const reviewing = entry.state === 'awaiting_review';
            const to = reviewing || entry.needsConfirm || !stable ? 'waiting_for_stable' : 'ready';
            hard.push(unlessMoved(entry, {
                ...entry, state: to, fingerprint: cap.fingerprint, attachments, observed: outcome.observed, needsConfirm: reviewing || entry.needsConfirm,
                text: undefined, noteText: undefined, proposal: undefined, attempts: 0, retriable: undefined, failedStage: undefined, stage: undefined, updatedAt: now,
            }));
            continue;
        }

        if (entry.state === 'waiting_for_stable' && stable && !entry.needsConfirm) {
            hard.push(unlessMoved(entry, { ...entry, state: 'ready', observed: outcome.observed, attachments, updatedAt: now }));
        } else if (entry.state === 'ready' && !stable) {
            hard.push(unlessMoved(entry, { ...entry, state: 'waiting_for_stable', observed: outcome.observed, updatedAt: now }));
        } else if (entry.state === 'failed' && entry.retriable && entry.attempts < MAX_ATTEMPTS && stable) {
            hard.push(unlessMoved(entry, { ...entry, state: 'ready', observed: outcome.observed, updatedAt: now }));
        } else if (observationsChanged(entry.observed, outcome.observed)) {
            // Observation churn only: coalesced, and it does not change `updatedAt` (it is not a decision).
            lazy.push((j) => {
                const live = getEntry(j, entry.id);
                return live && live.state === entry.state ? upsertEntry(j, { ...live, observed: outcome.observed }) : j;
            });
        }
    }

    // A held capture that no scan offers any more (its note was deleted, or moved out of the inbox) must not keep its
    // text in data.json, hold the sweep off, or count towards the review backlog.
    const seen = new Set([...scan.captures.map((c) => c.id), ...scan.skipped.map((x) => x.id)]);
    const inbox = config.inboxFolders.map(normalisePath).filter(Boolean);
    for (const entry of Object.values(snapshot.entries)) {
        if (!['new', 'waiting_for_stable', 'ready', 'awaiting_review', 'failed'].includes(entry.state) || seen.has(entry.id)) continue;
        if ((await deps.port.stat(entry.id)) !== null && inbox.some((f) => isInsideOrEqual(entry.id, f))) continue;
        hard.push((j) => {
            const live = getEntry(j, entry.id);
            if (!live || !['new', 'waiting_for_stable', 'ready', 'awaiting_review', 'failed'].includes(live.state)) return j;
            return finish(bumpBucket(upsertEntry(j, { ...live, text: undefined, noteText: undefined, proposal: undefined }), 'skipped', 'nothing-to-process'), entry.id, 'skipped', now, revision);
        });
    }

    if (hard.length > 0) await deps.journal.mutate((j) => hard.concat(lazy).reduce((acc, op) => op(acc), j));
    else if (lazy.length > 0) deps.journal.mutateLazy((j) => lazy.reduce((acc, op) => op(acc), j));
}

function newEntry(id: string, fingerprint: string, now: number, over: Partial<CaptureEntry>): CaptureEntry {
    return { id, uid: crypto.randomUUID(), state: 'new', fingerprint, processingVersion: PROCESSING_VERSION, attempts: 0, createdAt: now, updatedAt: now, ...over };
}

/** Persist a stage marker BEFORE the provider call it announces. */
async function markStage(deps: CaptureDeps, id: string, stage: CaptureStage, state: CaptureEntry['state'] = 'processing'): Promise<void> {
    await deps.journal.mutate((j) => {
        const e = getEntry(j, id);
        return e ? upsertEntry(j, { ...e, state, stage, updatedAt: deps.now() }) : j;
    });
    // The write-ahead marker must have landed on a live entry; if it vanished (skipped, deleted) nothing is sent.
    if (getEntry(deps.journal.get(), id)?.state !== state) throw new Cancelled();
}

/**
 * Process the entries that are `ready`, one at a time, until the limit, a cancel, or the review
 * backlog is full. Never throws.
 */
export async function runJobs(deps: CaptureDeps, scan: ScanOutcome, ctl: RunControl, limit: number): Promise<RunSummary> {
    const summary: RunSummary = { processed: 0, awaitingReview: 0, failed: 0, skipped: 0, waiting: 0, backpressure: false };
    const byId = new Map(scan.captures.map((c) => [c.id, c]));
    const ready = Object.values(deps.journal.get().entries)
        .filter((e) => e.state === 'ready' && byId.has(e.id))
        .sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of ready) {
        if (summary.processed >= limit || ctl.cancelled() || !deps.isEnabled()) break;
        if (!canStartProcessing(deps.journal.get())) {
            summary.backpressure = true;
            break;
        }
        const cap = byId.get(entry.id);
        if (!cap) continue;
        // The snapshot is old by now: only a capture that is still ready starts.
        if (getEntry(deps.journal.get(), entry.id)?.state !== 'ready') continue;
        // Let the UI breathe between jobs (mobile).
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const outcome = await processOne(deps, entry.id, cap, ctl);
        summary.processed++;
        if (outcome === 'review') summary.awaitingReview++;
        else if (outcome === 'failed') summary.failed++;
        else if (outcome === 'skipped') summary.skipped++;
    }
    summary.waiting = Object.values(deps.journal.get().entries).filter((e) => e.state === 'waiting_for_stable').length;
    return summary;
}

type JobOutcome = 'review' | 'failed' | 'skipped' | 'cancelled';

/**
 * The guard, re-run immediately before each stage that sends anything, on the note as it is NOW: a run can
 * take minutes, and a tag or word added after the scan must still stop the upload. A note that changed
 * since the scan is not judged at all: the job is dropped and the next scan starts it afresh.
 */
async function stillAllowed(deps: CaptureDeps, cap: ScannedCapture, extra?: string): Promise<SkipReason | null> {
    const policy = deps.policy();
    if (!deps.isEnabled()) throw new Cancelled();
    for (const path of [cap.id, ...cap.attachments.map((a) => a.path)]) if (pathExclusion(path, policy)) return 'excluded';
    // A note that embeds this media may have arrived since the scan: the media is then that note's, not a bare capture.
    if (cap.notePath === null && deps.vault.referrersOf(cap.id).length > 0) throw new Cancelled();
    if (cap.notePath !== null) {
        const read = await deps.vault.readText(cap.id);
        // A note that cannot be read now cannot be judged now: the job is dropped and the next scan starts it afresh.
        if (!read.ok || read.value !== cap.text) throw new Cancelled();
        if (exclusionReason(cap.id, read.value, policy)) return 'excluded';
    }
    if (extra !== undefined && machineTextExclusion(cap.id, extra, policy)) return 'excluded';
    return null;
}

/** The attachment's bytes, or a retriable failure (the file may simply not be readable yet). */
async function readAttachment(deps: CaptureDeps, path: string): Promise<Uint8Array> {
    const read = await deps.port.readBytes(path);
    // A file that is gone cannot become valid: it is skipped, as an empty read always was. A failed read may pass: retriable.
    if (!read.ok && read.error === CAPTURE_FILE_MISSING) throw new Skip('invalid-media');
    if (!read.ok) throw new Error('The attachment could not be read.');
    return read.value;
}

async function processOne(deps: CaptureDeps, id: string, cap: ScannedCapture, ctl: RunControl): Promise<JobOutcome> {
    const config = deps.config();
    const checkCancel = (): void => {
        if (ctl.cancelled() || !deps.isEnabled()) throw new Cancelled();
    };
    try {
        const early = await stillAllowed(deps, cap);
        if (early) throw new Skip(early);
        // Multi-device: a capture block with an id means a device already accepted this note.
        const block = findCaptureBlock(cap.text);
        if (block.ok && block.value !== null && readCaptureId(cap.text) !== null) throw new Skip('already-captured');
        if (cap.notePath !== null && (await deps.isSwept(id, cap.text))) throw new Skip('already-swept');

        const audio = cap.attachments.filter((a) => a.kind === 'audio');
        const images = cap.attachments.filter((a) => a.kind === 'image');
        const plan = planSources({
            body: cap.text,
            fileName: basename(id),
            audioCount: audio.length,
            imageCount: images.length,
            unsupportedCount: cap.attachments.filter((a) => a.kind === null).length,
            minWords: config.minWords,
            digitiseImagesWithText: config.digitiseImages,
            digitisationEnabled: deps.digitisationEnabled(),
            maxImages: config.maxImagesPerCapture,
            forceTranscribe: getEntry(deps.journal.get(), id)?.forceTranscribe,
        });
        if (plan.skip || !plan.source) throw new Skip(plan.skip ?? 'nothing-to-process');

        const machine: string[] = [];
        if (plan.transcribeAudio) {
            await markStage(deps, id, 'transcribe');
            for (const att of audio) {
                checkCancel();
                const bytes = await readAttachment(deps, att.path);
                if (bytes.byteLength > config.maxAttachmentBytes) throw new Skip('too-large');
                if (!checkSignature(att.path, bytes).ok) throw new Skip('invalid-media');
                await assertSameBytes(att, bytes);
                const sizeNow = await deps.port.stat(att.path);
                if (!sizeNow || sizeNow.size !== att.size) throw new Skip('invalid-media');
                const late = await stillAllowed(deps, cap);
                if (late) throw new Skip(late);
                const result = await deps.transcribe(bytes, basename(att.path), extensionOf(att.path));
                checkCancel();
                if (!result.ok) throw providerFailure(result.error);
                if (result.value.trim() === '') continue;
                if (machineTextExclusion(id, result.value, deps.policy())) throw new Skip('excluded');
                machine.push(result.value.trim());
            }
        }
        if (plan.digitiseImages > 0) {
            await markStage(deps, id, 'digitise');
            for (const att of images.slice(0, plan.digitiseImages)) {
                checkCancel();
                const now = await deps.port.stat(att.path);
                if (!now || now.size !== att.size) throw new Skip('invalid-media');
                const bytes = await readAttachment(deps, att.path);
                if (bytes.byteLength > config.maxAttachmentBytes) throw new Skip('too-large');
                if (!checkSignature(att.path, bytes).ok) throw new Skip('invalid-media');
                await assertSameBytes(att, bytes);
                const late = await stillAllowed(deps, cap);
                if (late) throw new Skip(late);
                // The very bytes that passed the signature, size and digest checks go to the pipeline, not the path.
                const result = await deps.digitise(bytes, basename(att.path), extensionOf(att.path));
                checkCancel();
                if (!result.ok) throw providerFailure(result.error);
                if (result.value.trim() === '') continue;
                if (machineTextExclusion(id, result.value, deps.policy())) throw new Skip('excluded');
                machine.push(result.value.trim());
            }
        }
        const machineText = machine.join('\n\n').slice(0, MAX_HELD_CHARS);
        // Held, shown and copied as the user wrote it; only the prompt below gets the stripped words.
        const noteText = plan.useNoteText ? userText(cap.text, basename(id)).slice(0, MAX_HELD_CHARS) : '';
        if (machineText === '' && noteText === '') throw new Skip('nothing-to-process');

        // Persist the paid-for text now (write-ahead for the classify stage), then classify.
        await markStage(deps, id, 'classify');
        await deps.journal.mutate((j) => {
            const e = getEntry(j, id);
            return e ? upsertEntry(j, { ...e, text: machineText, noteText, source: plan.source ?? undefined, updatedAt: deps.now() }) : j;
        });
        checkCancel();
        // Everything that awaits comes BEFORE the last guard, so nothing can change between the check and the call.
        const taxonomy = await deps.taxonomyPrompt();
        const beforeTagging = await stillAllowed(deps, cap, machineText);
        if (beforeTagging) throw new Skip(beforeTagging);
        const promptNote = plan.useNoteText ? usableText(cap.text, basename(id)).slice(0, MAX_HELD_CHARS) : '';
        const proposal = await classify(deps, cap, `${promptNote}\n\n${machineText}`.trim(), config, taxonomy);
        checkCancel();

        await deps.journal.mutate((j) => {
            const e = getEntry(j, id);
            if (!e) return j;
            return bump(upsertEntry(j, { ...e, state: 'awaiting_review', stage: undefined, proposal, retriable: undefined, failedStage: undefined, updatedAt: deps.now() }), 'processed');
        });
        return 'review';
    } catch (e) {
        return handleFailure(deps, id, e);
    }
}

async function classify(deps: CaptureDeps, cap: ScannedCapture, text: string, config: CaptureConfig, taxonomy: string) {
    const root = config.destinationRoot;
    const ctx = buildCaptureFolderContext(root, deps.listFolders(), (p) => deps.folderAllowed(p));
    const fallbackTitle = text.split(/\s+/).filter(Boolean).slice(0, 6).join(' ') || basename(cap.id).replace(/\.[^.]+$/, '');
    const allowed = ctx?.subfolders ?? [];
    let raw: RawProposal = {};
    // Last-resort destination without a model: the folder whose name shares words with the text.
    const lexical = (): string | null => rankByTitleOverlap('', text.slice(0, 600), allowed)[0]?.path ?? null;
    try {
        const parts = buildCaptureClassifyPrompt({ text, taxonomyPrompt: taxonomy, maxTags: deps.maxTags(), language: deps.language(), maxChars: config.maxTextChars, folderContext: ctx });
        const res = await deps.classify(parts);
        if (res.ok) raw = res.value;
    } catch {
        // A failed proposal degrades to a title from the text; the capture is still reviewable.
    }
    const proposal = parseProposal(raw, allowed, root, { maxTags: deps.maxTags(), fallbackTitle, formatTags: (tags) => deps.formatTags(tags) });
    if (ctx && proposal.folder === null) proposal.folder = lexical();
    return proposal;
}

async function handleFailure(deps: CaptureDeps, id: string, error: unknown): Promise<JobOutcome> {
    const now = deps.now();
    if (error instanceof Cancelled) {
        // The result of an in-flight call is discarded: the entry goes back to ready, attempts unchanged.
        await deps.journal.mutate((j) => {
            const e = getEntry(j, id);
            return e && e.state === 'processing' ? upsertEntry(j, { ...e, state: 'ready', stage: undefined, text: undefined, noteText: undefined, updatedAt: now }) : j;
        });
        return 'cancelled';
    }
    if (error instanceof Skip) {
        const revision = await policyRevisionOf(deps.policy());
        await deps.journal.mutate((j) => {
            const e = getEntry(j, id);
            if (!e) return j;
            // Nothing is persisted for a skipped capture: not the text, not a proposal.
            return finish(bumpBucket(upsertEntry(j, { ...e, text: undefined, noteText: undefined, proposal: undefined, skipReason: error.reason }), 'skipped', error.reason), id, 'skipped', now, revision);
        });
        return 'skipped';
    }
    const retriable = !(error instanceof NonRetriable);
    await deps.journal.mutate((j) => {
        const e = getEntry(j, id);
        if (!e) return j;
        const attempts = retriable ? e.attempts + 1 : e.attempts;
        const stage = e.stage ?? 'read';
        const errorText = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 160);
        return bumpBucket(upsertEntry(j, { ...e, state: 'failed', failedStage: stage, errorText, attempts, retriable: retriable && attempts < MAX_ATTEMPTS, stage: undefined, updatedAt: now }), 'failed', stage);
    });
    return 'failed';
}

/** The user presses Retry on a failed capture. */
export async function retryCapture(deps: CaptureDeps, id: string): Promise<boolean> {
    const e = getEntry(deps.journal.get(), id);
    if (!e || e.state !== 'failed') return false;
    await deps.journal.mutate((j) => upsertEntry(j, { ...e, state: 'ready', attempts: 0, retriable: undefined, failedStage: undefined, errorText: undefined, updatedAt: deps.now() }));
    return true;
}

/** The user confirms processing an edited capture again (it spends money, so it never starts on its own). */
export async function processAgain(deps: CaptureDeps, id: string): Promise<boolean> {
    const e = getEntry(deps.journal.get(), id);
    if (!e || e.state !== 'waiting_for_stable' || !e.needsConfirm) return false;
    await deps.journal.mutate((j) => upsertEntry(j, { ...e, needsConfirm: false, updatedAt: deps.now() }));
    return true;
}
