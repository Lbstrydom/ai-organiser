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
    isMetadataIndexReady,
    markAudioRemovedText,
    ownNoteIsReferenceFree,
    parseEpisodeContent,
    readEpisodeResult,
    trashOwnedFile,
} from './catchUpEpisode';
import { runExclusive } from './catchUpService';
import { CATCHUP_CLEANUP_MAX_DAYS, EPISODE_FM, type EpisodeMeta } from './catchUpTypes';

// ── Types ────────────────────────────────────────────────────────────────────

export type CleanupSkipReason =
    | 'off'
    | 'busy'
    | 'index-not-ready'
    | 'record-unknown'
    | 'changed-during-sweep';

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
}

/** Clamp a stored setting to the supported range; anything unusable is off. */
export function normaliseCleanupDays(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return 0;
    return Math.min(CATCHUP_CLEANUP_MAX_DAYS, Math.floor(n));
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

/**
 * Built ONCE per sweep: the reverse link table in one pass over `resolvedLinks`, and one read of
 * each markdown note in the folder. Linear in the notes, never per candidate.
 */
export async function buildReferenceIndex(app: App, outputRoot: string): Promise<ReferenceIndex> {
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

    const texts = new Map<string, string>();
    let unreadable = false;
    for (const file of childrenOf(app, folder)) {
        if (!file.name.endsWith('.md')) continue;
        try {
            texts.set(file.path, (await app.vault.cachedRead(file)).toLowerCase());
        } catch (e) {
            logger.warn('Newsletter', `Cleanup could not read ${file.path} while indexing references`, e);
            unreadable = true;
        }
    }

    return {
        referencedElsewhere(audioName, ownNotePath) {
            const name = audioName.toLowerCase();
            const audioPath = normalizePath(`${folder}/${audioName}`).toLowerCase();
            for (const source of linkers.get(audioPath) ?? []) if (source !== ownNotePath) return 'yes';
            for (const [path, text] of texts) if (path !== ownNotePath && text.includes(name)) return 'yes';
            return unreadable ? 'unknown' : 'no';
        },
    };
}

// ── Change tracking during the destructive phase ─────────────────────────────

interface ChangeTracker {
    /** Paths this sweep wrote itself; their own events are not "someone else changed the vault". */
    touched: Set<string>;
    isDirty(): boolean;
    dispose(): void;
}

function trackChanges(app: App): ChangeTracker {
    const touched = new Set<string>();
    let dirty = false;
    const refs: Array<{ owner: 'vault' | 'cache'; ref: EventRef }> = [];
    const seen = (path: unknown): void => {
        if (typeof path === 'string' && path.endsWith('.md') && !touched.has(path)) dirty = true;
    };
    const vaultOn = app.vault.on.bind(app.vault) as (name: string, cb: (file: { path: string }, old?: string) => void) => EventRef;
    const cacheOn = app.metadataCache.on.bind(app.metadataCache) as unknown as (name: string, cb: (file: { path: string }) => void) => EventRef;
    for (const name of ['create', 'modify', 'delete']) refs.push({ owner: 'vault', ref: vaultOn(name, (f) => seen(f?.path)) });
    refs.push({ owner: 'vault', ref: vaultOn('rename', (f, old) => { seen(f?.path); seen(old); }) });
    for (const name of ['changed', 'deleted']) refs.push({ owner: 'cache', ref: cacheOn(name, (f) => seen(f?.path)) });
    return {
        touched,
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

async function sweep(deps: CleanupDeps): Promise<Result<CleanupOutcome>> {
    const { app } = deps;
    if (!isMetadataIndexReady(app)) return ok({ kind: 'skipped', reason: 'index-not-ready' });

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
    let pending = 0;
    let marked = 0;
    let removed = 0;
    const skip = (id: string, reason: string, isPending = false): void => {
        bump(skipped, reason);
        items.push({ id, action: 'skipped', reason });
        if (isPending) pending++;
        logger.debug('Newsletter', `Cleanup skipped ${id}: ${reason}`);
    };
    const fail = (id: string, source: string, error: string): void => {
        errors.push({ source, error });
        items.push({ id, action: 'error', reason: error });
        logger.warn('Newsletter', `Cleanup could not process ${source}: ${error}`);
    };
    const report = (): CleanupReport => ({
        marked,
        removed,
        markedPending: pending,
        skipped,
        items: { items, errors, warnings: [], isPartial: errors.length > 0 },
    });

    // Discovery by NAME and the metadata cache only: episodes inside the age window cost no read.
    const candidates: Candidate[] = [];
    for (const file of childrenOf(app, folder)) {
        const named = parseEpisodeName(file.name);
        if (!named) continue;
        const cached = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const markedInCache = cached?.[EPISODE_FM.audioRemoved] !== undefined;
        if (!markedInCache && !(named.to < cutoff)) continue;

        const read = await readEpisodeResult(app, file);
        if (read.kind !== 'ok') { skip(named.id, read.kind === 'invalid' ? 'note-invalid' : 'note-unreadable'); continue; }
        const meta = read.meta;
        const audioPath = normalizePath(`${folder}/${meta.audio}`);
        const audioExists = app.vault.getAbstractFileByPath(audioPath) instanceof TFile;
        const decision = decideEpisode({ meta, acks, today, cutoff, audioExists, inflight });
        if ('done' in decision) continue;
        if ('skip' in decision) { skip(meta.id, decision.skip, decision.pending === true); continue; }
        candidates.push({ file, meta, audioPath, stage: decision.stage });
    }
    if (candidates.length === 0) return ok({ kind: 'completed', report: report() });

    // Everything below can change the vault: it needs a fresh, complete picture and a watch on it.
    const index = await buildReferenceIndex(app, outputRoot);
    const tracker = trackChanges(app);
    try {
        for (const c of candidates) {
            if (tracker.isDirty()) {
                logger.warn('Newsletter', 'Cleanup stopped: the vault changed during the sweep');
                return ok({ kind: 'skipped', reason: 'changed-during-sweep', report: report() });
            }
            const id = c.meta.id;
            const notePath = c.file.path;
            if (!isInsideOutputRoot(folder, notePath) || !isInsideOutputRoot(folder, c.audioPath)) { skip(id, 'outside-catchup-folder'); continue; }
            if (!assertWritable(deps.protectedSource, 'modify', notePath).ok || !assertWritable(deps.protectedSource, 'delete', c.audioPath).ok) {
                skip(id, 'protected-folder');
                continue;
            }
            if (index.referencedElsewhere(c.meta.audio, notePath) !== 'no') { skip(id, 'audio-referenced-elsewhere'); continue; }

            let fresh: string;
            try {
                fresh = await app.vault.read(c.file);
            } catch (e) {
                fail(id, notePath, e instanceof Error ? e.message : String(e));
                continue;
            }
            // The fresh content must still describe THIS candidate.
            const current = parseEpisodeContent(fresh, notePath);
            if (!current || current.id !== id || current.audio !== c.meta.audio) { skip(id, 'note-changed'); continue; }

            if (c.stage === 'mark') {
                const next = markAudioRemovedText(fresh, c.meta.audio, today, deps.removedLine(today));
                if (!next.ok) { skip(id, next.error); continue; }
                tracker.touched.add(notePath);
                const written = await deps.writeNote(notePath, fresh, next.value);
                if (!written.ok) { fail(id, notePath, written.error); continue; }
                marked++;
                pending++;
                items.push({ id, action: 'marked' });
                logger.debug('Newsletter', `Cleanup marked ${id}`);
                continue;
            }

            // Stage 2: the marker must still be there, and the note still free of any reference.
            if (current.audioRemoved !== c.meta.audioRemoved) { skip(id, 'note-changed'); continue; }
            if (!ownNoteIsReferenceFree(fresh, c.meta.audio)) { skip(id, 'note-still-references-audio'); continue; }
            try {
                tracker.touched.add(c.audioPath);
                const trashed = await trashOwnedFile(app, outputRoot, c.audioPath);
                if (!trashed) { skip(id, 'audio-missing'); continue; }
                removed++;
                items.push({ id, action: 'removed' });
                logger.debug('Newsletter', `Cleanup removed the audio of ${id}`);
            } catch (e) {
                fail(id, c.audioPath, e instanceof Error ? e.message : String(e));
                pending++;
            }
        }
    } finally {
        tracker.dispose();
    }
    return ok({ kind: 'completed', report: report() });
}
