/**
 * Catch-up audio cleanup — remove the MP3 of HEARD episodes, keep the episode note.
 *
 * Opt-in (days = 0 is off and does nothing, not even a read). Two stages, one per sweep:
 *
 *  1. MARK   a live episode that is heard, old enough and safe gets `catchup_audio_removed` and its
 *            listen line rewritten. Its coverage is unchanged, so its days never become pending.
 *  2. TRASH  a marked episode whose marker is from an EARLIER day (so a second device has had time
 *            to receive the marked note) has its MP3 trashed with `fileManager.trashFile`.
 *
 * The note edit always comes first: trashing first would drop the episode out of coverage if the
 * edit then failed. Everything unknown fails closed: an index that is not ready, a note that
 * cannot be read or parsed, an unreadable operation record, a vault change during the sweep.
 */

import type { App, EventRef, Plugin } from 'obsidian';
import { TFile, normalizePath } from 'obsidian';
import { ok, err, type BatchError, type BatchResult, type Result } from '../../../core/result';
import { assertWritable, type ProtectedSource } from '../../../core/protectedPaths';
import { loadPluginData } from '../../../core/pluginDataStore';
import { getNewsletterOutputFullPath, type AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { waitForMetadataIndex, type WaitResult } from '../../../utils/metadataIndexState';
import { isCatchUpEnabled } from '../newsletterAudioMode';
import { getBucketDateStr } from '../newsletterService';
import { newestCoveredDate, parseEpisodeName, shiftDate } from './catchUpCoverage';
import {
    ACKS_DATA_KEY,
    DRAFT_DATA_KEY,
    coerceAcks,
    coerceRecord,
    storedRecordStatus,
    type AckMap,
} from './catchUpDraft';
import {
    childrenOf,
    episodeFolderPath,
    isInsideOutputRoot,
    markAudioRemovedText,
    ownNoteIsReferenceFree,
    parseEpisodeContent,
    readEpisodeResult,
    trashOwnedFile,
} from './catchUpEpisode';
import { runExclusive } from './catchUpService';
import { EPISODE_FM, normaliseCleanupDays, type EpisodeMeta } from './catchUpTypes';

export { normaliseCleanupDays };

// ── Types ────────────────────────────────────────────────────────────────────

export type CleanupSkipReason =
    | 'off'
    | 'busy'
    /** The link index is still being built (or being updated by the sweep's own write): retry soon. */
    | 'index-not-ready'
    /** Nothing establishes whether the link index is complete (neither flag nor a `resolved` event yet): fail closed, retry on the next `resolved`. */
    | 'index-unavailable'
    | 'record-unknown'
    | 'changed-during-sweep'
    | 'cancelled';

export interface EpisodeOutcome {
    id: string;
    action: 'marked' | 'removed' | 'skipped' | 'error';
    reason?: string;
}

export interface CleanupReport {
    /** Stage 1 completed this sweep. */
    marked: number;
    /** Audio files trashed this sweep. */
    removed: number;
    /** Marked episodes still waiting for stage 2 for a reason that will pass (a later day, a transient failure). */
    markedPending: number;
    /** The part of markedPending held up by something that may pass within the day (a failed read or trash, an unknown reference): worth retrying before tomorrow. */
    retryPending: number;
    skipped: Record<string, number>;
    items: BatchResult<EpisodeOutcome>;
}

export type CleanupOutcome =
    | { kind: 'completed'; report: CleanupReport }
    | { kind: 'skipped'; reason: CleanupSkipReason; /** Work done before the sweep had to stop. */ report?: CleanupReport };

export interface CleanupDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    /** Remove-after threshold in days; 0 (or anything not a positive number) is off. */
    days: number;
    protectedSource: ProtectedSource;
    /** Compare-and-commit note write (the plugin's applyNoteEdit); a baseline mismatch is an error. */
    writeNote: (path: string, baseline: string, next: string) => Promise<Result<void>>;
    /** The sentence that replaces the audio embed, e.g. "Audio removed on 2026-10-23". */
    removedLine: (date: string) => string;
    now?: () => Date;
    /** Polled before every destructive step: true ends the sweep as `cancelled` (the plugin was unloaded). */
    shouldStop?: () => boolean;
    /** Test seam: wait for the link index to be ready. Defaults to the real, cancellable wait. */
    waitForIndex?: (timeoutMs: number) => Promise<WaitResult>;
}

/** How long the sweep waits for the link index at the start, and before each destructive step. */
const INDEX_WAIT_MS = 20_000;
const INDEX_RECHECK_MS = 5_000;

// ── Scheduling (pure) ────────────────────────────────────────────────────────

/**
 * Should the 30-minute tick run a sweep? Costs no vault read: off never; otherwise only on a new
 * calendar day since the last COMPLETED sweep (live episodes cross the age cutoff in a long
 * session), or while something that may pass within the day is holding up a marked episode (or
 * that is not yet known). A marked episode that merely waits for tomorrow is picked up by the new-day
 * rule: a same-day sweep could not act on it.
 */
export function shouldSweepOnTick(i: { days: number; today: string; lastCompletedDate: string | null; retryPending: number | 'unknown' }): boolean {
    if (!(i.days > 0)) return false;
    return i.lastCompletedDate !== i.today || i.retryPending !== 0;
}

/**
 * One-shot "a sweep was held up by the link index" latch. A skipped sweep arms it; the first
 * `resolved` event after that fires it exactly once (and disarms), so the cleanup recovers as soon as
 * indexing completes instead of waiting for tomorrow. Ordinary later `resolved` events do nothing.
 */
export interface IndexRetryGate {
    arm(): void;
    /** Call on every `resolved`: true exactly when a retry should now be scheduled. */
    onResolved(): boolean;
    /** A sweep completed: nothing is waiting any more. */
    disarm(): void;
    isArmed(): boolean;
}

export function createIndexRetryGate(): IndexRetryGate {
    let armed = false;
    return {
        arm: () => { armed = true; },
        onResolved: () => { const was = armed; armed = false; return was; },
        disarm: () => { armed = false; },
        isArmed: () => armed,
    };
}

/** Skips caused by the link index, which a later `resolved` can cure. */
export function isIndexSkip(reason: CleanupSkipReason): boolean {
    return reason === 'index-not-ready' || reason === 'index-unavailable';
}

// ── Pure decision ────────────────────────────────────────────────────────────

export interface DecideInput {
    meta: EpisodeMeta;
    acks: Readonly<AckMap>;
    today: string;
    /** Newest covered day must be strictly before this. */
    cutoff: string;
    audioExists: boolean;
    /** The stored operation record, when valid: an episode it names is not touched. */
    inflight: { opId: string; audioName: string } | null;
}

export type Decision =
    | { stage: 'mark' | 'trash' }
    | { done: true }
    | { skip: string; pending?: boolean };

/**
 * Which stage, if any, this episode is in. Pure. The heard ack is required for BOTH stages: the
 * marker alone is never authority to delete, so a hand-added marker deletes nothing.
 */
export function decideEpisode(i: DecideInput): Decision {
    const { meta } = i;
    if (meta.audioRemoved && !i.audioExists) return { done: true };
    if (i.inflight && (i.inflight.opId === meta.id || i.inflight.audioName === meta.audio)) return { skip: 'operation-in-flight' };
    // The reference scan only recognises names up to this length; a longer one could be mentioned unseen.
    if (meta.audio.length > MAX_AUDIO_NAME_LENGTH) return { skip: 'audio-name-too-long' };
    if (!(meta.id in i.acks)) return { skip: meta.audioRemoved ? 'marker-without-ack' : 'not-heard' };

    if (meta.audioRemoved) {
        // Stage 2 waits for a LATER calendar day than the marker.
        return meta.audioRemoved < i.today ? { stage: 'trash' } : { skip: 'waiting-for-next-day', pending: true };
    }
    if (!i.audioExists) return { skip: 'audio-missing' };
    if (!(newestCoveredDate(meta) < i.cutoff)) return { skip: 'too-recent' };
    return { stage: 'mark' };
}

// ── Reference index (one snapshot per sweep) ─────────────────────────────────

export type Reference = 'yes' | 'no' | 'unknown';

export interface ReferenceIndex {
    /** Does anything other than `ownNotePath` reference this audio file? */
    referencedElsewhere(audioName: string, ownNotePath: string): Reference;
}

/** The catch-up audio names a text mentions, lower-cased. Mirrors the validated `isEpisodeAudioName` alphabet. */
const AUDIO_RUN_RE = /catchup-[a-z0-9._-]+/gi;
/** A real episode audio name is about 41 characters; a longer one is never cleaned up (fail closed). */
export const MAX_AUDIO_NAME_LENGTH = 96;

/**
 * Every catch-up audio name a text could be mentioning, lower-cased. The alphabet includes '.', so
 * two names can run together (`catchup-a.mp3.catchup-b.mp3`): every start of `catchup-` inside a
 * run and every `.mp3` end within the name-length bound after it is registered, so adjacent names
 * never hide each other and a name holding several `.mp3` is still found whole.
 */
export function audioNamesIn(text: string): Set<string> {
    const names = new Set<string>();
    for (const run of text.toLowerCase().matchAll(AUDIO_RUN_RE)) {
        const s = run[0];
        // One pass finds every end; the cursor over them only moves forward as the starts do, so the
        // work is linear in the run however many starts or ends it holds.
        const ends: number[] = [];
        for (let e = s.indexOf('.mp3'); e !== -1; e = s.indexOf('.mp3', e + 1)) ends.push(e);
        if (ends.length === 0) continue;
        let cursor = 0;
        for (let start = s.indexOf('catchup-'); start !== -1; start = s.indexOf('catchup-', start + 1)) {
            while (cursor < ends.length && ends[cursor] < start + 8) cursor++;
            // Every end within the length bound counts (so a name with several `.mp3` is never missed).
            // The bound is what keeps this linear: at most a name-length worth of ends per start, and
            // hashing a substring costs its length, which an unbounded one would make quadratic.
            for (let n = cursor; n < ends.length; n++) {
                if (ends[n] + 4 - start > MAX_AUDIO_NAME_LENGTH) break;
                names.add(s.slice(start, ends[n] + 4));
            }
        }
    }
    return names;
}

/** Is the vault's reverse-link table actually there? An absent table is "unknown", never "no links". */
export function hasLinkTable(app: App): boolean {
    const table = (app.metadataCache as { resolvedLinks?: unknown }).resolvedLinks;
    return typeof table === 'object' && table !== null;
}

/**
 * Built ONCE per sweep from the folder's file list: the reverse link table in one pass over
 * `resolvedLinks`, and ONE text pass over each markdown note that records which catch-up audio
 * names it mentions. A query is then a map lookup, so the work is linear in the notes however many
 * candidates there are.
 */
export async function buildReferenceIndex(app: App, outputRoot: string, folderFiles: readonly TFile[]): Promise<ReferenceIndex> {
    const folder = episodeFolderPath(outputRoot);
    const prefix = `${folder.toLowerCase()}/`;
    const linkers = new Map<string, Set<string>>();
    const resolved = (app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
    for (const [source, targets] of Object.entries(resolved)) {
        for (const target of Object.keys(targets ?? {})) {
            const key = target.toLowerCase();
            if (!key.startsWith(prefix) || !key.endsWith('.mp3')) continue;
            let set = linkers.get(key);
            if (!set) { set = new Set(); linkers.set(key, set); }
            set.add(source);
        }
    }

    const mentions = new Map<string, Set<string>>();
    let unreadable = false;
    for (const file of folderFiles) {
        if (!file.name.endsWith('.md')) continue;
        let text: string;
        try {
            text = await app.vault.cachedRead(file);
        } catch (e) {
            logger.warn('Newsletter', `Cleanup could not read ${file.path} while indexing references`, e);
            unreadable = true;
            continue;
        }
        for (const name of audioNamesIn(text)) {
            let set = mentions.get(name);
            if (!set) { set = new Set(); mentions.set(name, set); }
            set.add(file.path);
        }
    }

    return {
        referencedElsewhere(audioName, ownNotePath) {
            const name = audioName.toLowerCase();
            const audioPath = normalizePath(`${folder}/${audioName}`).toLowerCase();
            for (const source of linkers.get(audioPath) ?? []) if (source !== ownNotePath) return 'yes';
            for (const path of mentions.get(name) ?? []) if (path !== ownNotePath) return 'yes';
            return unreadable ? 'unknown' : 'no';
        },
    };
}

// ── Change tracking: from before discovery until the last destructive step ───

export interface ChangeTracker {
    /**
     * Declare the events this sweep's OWN note write will cause, so only those are ignored. Returns
     * the way to revoke what has not been consumed: a write that fails leaves no standing exemption.
     */
    expectNoteWrite(path: string): () => void;
    isDirty(): boolean;
    dispose(): void;
}

/**
 * Any markdown change the sweep did not cause means a reference could have appeared since the
 * snapshot, so it marks the sweep dirty. The sweep's own write is recognised by a one-shot token
 * per expected event (a `modify` and a `changed`), never by exempting the path for the whole
 * sweep: a later external edit of the same note still counts.
 */
export function trackChanges(app: App): ChangeTracker {
    const expected = new Map<string, number>();
    let dirty = false;
    const refs: Array<{ owner: 'vault' | 'cache'; ref: EventRef }> = [];
    const seen = (owner: 'vault' | 'cache', name: string, path: unknown): void => {
        if (typeof path !== 'string' || !path.endsWith('.md')) return;
        const key = `${owner}:${name}:${path}`;
        const left = expected.get(key) ?? 0;
        if (left > 0) { expected.set(key, left - 1); return; }
        dirty = true;
    };
    const vaultOn = app.vault.on.bind(app.vault) as (name: string, cb: (file: { path: string }, old?: string) => void) => EventRef;
    const cacheOn = app.metadataCache.on.bind(app.metadataCache) as unknown as (name: string, cb: (file: { path: string }) => void) => EventRef;
    for (const name of ['create', 'modify', 'delete']) refs.push({ owner: 'vault', ref: vaultOn(name, (f) => seen('vault', name, f?.path)) });
    refs.push({ owner: 'vault', ref: vaultOn('rename', (f, old) => { seen('vault', 'rename', f?.path); seen('vault', 'rename', old); }) });
    for (const name of ['changed', 'deleted']) refs.push({ owner: 'cache', ref: cacheOn(name, (f) => seen('cache', name, f?.path)) });
    return {
        expectNoteWrite(path) {
            const keys = [`vault:modify:${path}`, `cache:changed:${path}`];
            for (const key of keys) expected.set(key, (expected.get(key) ?? 0) + 1);
            return () => { for (const key of keys) expected.set(key, Math.max(0, (expected.get(key) ?? 0) - 1)); };
        },
        isDirty: () => dirty,
        dispose() {
            for (const { owner, ref } of refs) {
                if (owner === 'vault') app.vault.offref(ref);
                else app.metadataCache.offref(ref);
            }
        },
    };
}

// ── The sweep ────────────────────────────────────────────────────────────────

interface Candidate {
    file: TFile;
    meta: EpisodeMeta;
    audioPath: string;
    stage: 'mark' | 'trash';
}

const bump = (counts: Record<string, number>, key: string): void => { counts[key] = (counts[key] ?? 0) + 1; };

/**
 * One cleanup sweep. Never throws: every failure becomes a `Result.err` or a skipped outcome.
 * Off (days <= 0, or catch-up disabled) returns before ANY vault, cache or plugin-data access.
 */
export async function runCatchUpAudioCleanup(deps: CleanupDeps): Promise<Result<CleanupOutcome>> {
    try {
        if (!(deps.days > 0) || !isCatchUpEnabled(deps.settings)) return ok({ kind: 'skipped', reason: 'off' });
        const locked = await runExclusive<CleanupOutcome>(() => sweep(deps));
        if (!locked.ok && locked.error === 'catchup-busy') return ok({ kind: 'skipped', reason: 'busy' });
        return locked;
    } catch (e) {
        logger.warn('Newsletter', 'Catch-up audio cleanup failed', e);
        return err(e instanceof Error ? e.message : String(e));
    }
}

/** Skip reasons that will pass by themselves: a marked episode hitting one is still waiting. */
const TRANSIENT_FOR_MARKED = new Set(['audio-reference-unknown', 'note-unreadable', 'note-changed']);

async function sweep(deps: CleanupDeps): Promise<Result<CleanupOutcome>> {
    const { app } = deps;
    const awaitIndex = (timeoutMs: number): Promise<WaitResult> => (deps.waitForIndex
        ? deps.waitForIndex(timeoutMs)
        : waitForMetadataIndex(app, { timeoutMs, shouldStop: deps.shouldStop }));
    // Nothing is read until the link index is complete: a "no reference" drawn from a partial one is a guess.
    const first = await awaitIndex(INDEX_WAIT_MS);
    if (first.outcome === 'aborted') return ok({ kind: 'skipped', reason: 'cancelled' });
    if (first.outcome !== 'ready') {
        if (first.state === 'unknown') logger.warn('Newsletter', 'Catch-up audio cleanup is waiting: Obsidian has not reported that its link index is complete');
        return ok({ kind: 'skipped', reason: first.state === 'unknown' ? 'index-unavailable' : 'index-not-ready' });
    }
    if (!hasLinkTable(app)) return ok({ kind: 'skipped', reason: 'index-unavailable' });

    const data = await loadPluginData(deps.plugin);
    const recordStatus = storedRecordStatus(data[DRAFT_DATA_KEY]);
    if (recordStatus === 'unsupported' || recordStatus === 'corrupt') return ok({ kind: 'skipped', reason: 'record-unknown' });
    const record = recordStatus === 'valid' ? coerceRecord(data[DRAFT_DATA_KEY]) : null;
    const inflight = record ? { opId: record.opId, audioName: (record.audio?.path ?? '').split('/').pop() ?? '' } : null;
    const acks = coerceAcks(data[ACKS_DATA_KEY]);

    const now = (deps.now ?? (() => new Date()))();
    const today = getBucketDateStr(now, deps.settings.newsletterBriefCutoffHour ?? 6, deps.settings.newsletterBriefCutoffMinute ?? 0);
    const cutoff = shiftDate(today, -deps.days);
    const outputRoot = getNewsletterOutputFullPath(deps.settings);
    const folder = episodeFolderPath(outputRoot);

    const items: EpisodeOutcome[] = [];
    const errors: BatchError[] = [];
    const skipped: Record<string, number> = {};
    let waiting = 0; // marked, but stage 2 cannot happen before a later day
    let retrying = 0; // marked, and held up by something that may pass within the day
    let marked = 0;
    let removed = 0;
    const skip = (id: string, reason: string, wait?: 'wait' | 'retry'): void => {
        bump(skipped, reason);
        items.push({ id, action: 'skipped', reason });
        if (wait === 'wait') waiting++;
        if (wait === 'retry') retrying++;
        logger.debug('Newsletter', `Cleanup skipped ${id}: ${reason}`);
    };
    const fail = (id: string, source: string, error: string, retry = false): void => {
        errors.push({ source, error });
        items.push({ id, action: 'error', reason: error });
        if (retry) retrying++;
        logger.warn('Newsletter', `Cleanup could not process ${source}: ${error}`);
    };
    const report = (): CleanupReport => ({
        marked,
        removed,
        markedPending: waiting + retrying,
        retryPending: retrying,
        skipped,
        items: { items, errors, warnings: [], isPartial: errors.length > 0 },
    });
    /** Ends the sweep, with the reason, when it was cancelled or the vault changed under it. */
    const halted = (): Result<CleanupOutcome> | null => {
        if (deps.shouldStop?.()) return ok({ kind: 'skipped', reason: 'cancelled', report: report() });
        return tracker.isDirty() ? changed() : null;
    };
    const changed = (): Result<CleanupOutcome> => {
        logger.warn('Newsletter', 'Cleanup stopped: the vault changed during the sweep');
        return ok({ kind: 'skipped', reason: 'changed-during-sweep', report: report() });
    };

    // Watching starts BEFORE anything is read, so nothing that happens during discovery or while the
    // reference snapshot is built can be missed.
    const tracker = trackChanges(app);
    try {
        // Discovery by NAME and the metadata cache only: episodes inside the age window cost no read.
        const folderFiles = childrenOf(app, folder);
        const candidates: Candidate[] = [];
        for (const file of folderFiles) {
            const named = parseEpisodeName(file.name);
            if (!named) continue;
            const cached = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
            const markedInCache = cached?.[EPISODE_FM.audioRemoved] !== undefined;
            if (!markedInCache && !(named.to < cutoff)) continue;

            const read = await readEpisodeResult(app, file);
            if (read.kind !== 'ok') {
                skip(named.id, read.kind === 'invalid' ? 'note-invalid' : 'note-unreadable', read.kind === 'unreadable' && markedInCache ? 'retry' : undefined);
                continue;
            }
            const meta = read.meta;
            const audioPath = normalizePath(`${folder}/${meta.audio}`);
            const audioExists = app.vault.getAbstractFileByPath(audioPath) instanceof TFile;
            const decision = decideEpisode({ meta, acks, today, cutoff, audioExists, inflight });
            if ('done' in decision) continue;
            if ('skip' in decision) { skip(meta.id, decision.skip, decision.pending === true ? 'wait' : undefined); continue; }
            candidates.push({ file, meta, audioPath, stage: decision.stage });
        }
        if (candidates.length === 0) return ok({ kind: 'completed', report: report() });

        // Everything below can change the vault: it needs a fresh, complete picture.
        const index = await buildReferenceIndex(app, outputRoot, folderFiles);
        {
            const stop = halted();
            if (stop) return stop;
        }

        for (const c of candidates) {
            const stop = halted();
            if (stop) return stop;
            const id = c.meta.id;
            const notePath = c.file.path;
            const isStage2 = c.stage === 'trash';
            if (!isInsideOutputRoot(folder, notePath) || !isInsideOutputRoot(folder, c.audioPath)) { skip(id, 'outside-catchup-folder'); continue; }
            if (!assertWritable(deps.protectedSource, 'modify', notePath).ok || !assertWritable(deps.protectedSource, 'delete', c.audioPath).ok) {
                skip(id, 'protected-folder');
                continue;
            }
            const referenced = index.referencedElsewhere(c.meta.audio, notePath);
            if (referenced !== 'no') {
                const reason = referenced === 'unknown' ? 'audio-reference-unknown' : 'audio-referenced-elsewhere';
                skip(id, reason, isStage2 && TRANSIENT_FOR_MARKED.has(reason) ? 'retry' : undefined);
                continue;
            }

            // The sweep's own marker write re-indexes the note (`changed`, then `resolved`): wait for
            // that before the next decision, and never act on an index that has not settled.
            const settled = await awaitIndex(INDEX_RECHECK_MS);
            if (settled.outcome === 'aborted') return ok({ kind: 'skipped', reason: 'cancelled', report: report() });
            if (settled.outcome !== 'ready') {
                logger.debug('Newsletter', `Cleanup stopped: the link index did not settle (${settled.state})`);
                return ok({ kind: 'skipped', reason: settled.state === 'unknown' ? 'index-unavailable' : 'index-not-ready', report: report() });
            }

            let fresh: string;
            try {
                fresh = await app.vault.read(c.file);
            } catch (e) {
                fail(id, notePath, e instanceof Error ? e.message : String(e), isStage2);
                continue;
            }
            // The fresh content must still describe THIS candidate.
            const current = parseEpisodeContent(fresh, notePath);
            if (!current || current.id !== id || current.audio !== c.meta.audio) { skip(id, 'note-changed', isStage2 ? 'retry' : undefined); continue; }
            // A change that arrived while the note was being read invalidates the snapshot.
            {
                const stop = halted();
                if (stop) return stop;
            }

            if (c.stage === 'mark') {
                const next = markAudioRemovedText(fresh, c.meta.audio, today, deps.removedLine(today), folder);
                if (!next.ok) { skip(id, next.error); continue; }
                const revoke = tracker.expectNoteWrite(notePath);
                let written: Result<void>;
                try {
                    written = await deps.writeNote(notePath, fresh, next.value);
                } catch (e) {
                    written = err(e instanceof Error ? e.message : String(e));
                }
                if (!written.ok) {
                    // A failed or ambiguous write may mean the note changed under us: nothing it left
                    // behind may be trusted, so revoke the exemption and end the sweep.
                    revoke();
                    fail(id, notePath, written.error);
                    return changed();
                }
                marked++;
                waiting++;
                items.push({ id, action: 'marked' });
                logger.debug('Newsletter', `Cleanup marked ${id}`);
                continue;
            }

            // Stage 2: the marker must still be there, and the note still free of any reference.
            if (current.audioRemoved !== c.meta.audioRemoved) { skip(id, 'note-changed', 'retry'); continue; }
            if (!ownNoteIsReferenceFree(fresh, c.meta.audio)) { skip(id, 'note-still-references-audio'); continue; }
            try {
                const trashed = await trashOwnedFile(app, outputRoot, c.audioPath);
                if (!trashed) { skip(id, 'audio-missing'); continue; }
                removed++;
                items.push({ id, action: 'removed' });
                logger.debug('Newsletter', `Cleanup removed the audio of ${id}`);
            } catch (e) {
                fail(id, c.audioPath, e instanceof Error ? e.message : String(e), true);
            }
        }
        return ok({ kind: 'completed', report: report() });
    } finally {
        tracker.dispose();
    }
}
