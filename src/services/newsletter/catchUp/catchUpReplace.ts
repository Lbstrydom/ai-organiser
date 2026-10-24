/**
 * Catch-up replace — swap unheard episodes for ONE fresh catch-up covering everything.
 *
 * The old episodes are retired only AFTER the replacement is committed, never before: their days
 * are made pending again logically (`excludeEpisodeIds`, read-only), the new episode is planned
 * and made over all of them, and only then do the old notes and audio go to the user's trash. A
 * failed script or voice therefore never leaves the reader with neither episode.
 *
 * Every retirement is judged twice by the same assessment, once under the lock before anything
 * is spent and again immediately before each trash, because making an episode takes minutes
 * during which the reader may have started to listen. Anything unknown fails closed.
 */

import { TFile, normalizePath, type App, type Plugin } from 'obsidian';
import { ok, err, type Result } from '../../../core/result';
import { assertWritable } from '../../../core/protectedPaths';
import { getNewsletterOutputFullPath, type AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { waitForMetadataIndex, type WaitResult } from '../../../utils/metadataIndexState';
import { isCatchUpEnabled } from '../newsletterAudioMode';
import { isFeatureEnabled } from '../../featureService';
import { isEpisodeAudioName, parseEpisodeName } from './catchUpCoverage';
import { ACKS_DATA_KEY, DRAFT_DATA_KEY, coerceAcks, coerceRecord, storedRecordStatus } from './catchUpDraft';
import {
    OUTPUT_PROTECTED,
    assertEpisodeOutputWritable,
    episodeFolderPath,
    isInsideOutputRoot,
    readEpisodeResult,
    trashOwnedFile,
} from './catchUpEpisode';
import { hasLinkTable } from './catchUpCleanup';
import { probeEpisodePlaying, type PlaybackProbe } from './catchUpPlayback';
import { buildCatchUpSnapshot, type CatchUpSnapshot } from './catchUpSelection';
import {
    reconcileOperation,
    runCatchUpLocked,
    runExclusive,
    type CatchUpPorts,
    type EpisodeResult,
    type RunOptions,
} from './catchUpService';
import type { EpisodeMeta } from './catchUpTypes';

// ── Types ────────────────────────────────────────────────────────────────────

export type ReplacePurpose = 'manual' | 'auto';

/** Why an episode may not be replaced. Stable codes; the window turns them into plain sentences. */
export type RefuseReason =
    | 'note-unexpected'
    | 'audio-unexpected'
    | 'protected'
    | 'acked'
    | 'acks-unreadable'
    | 'record-in-flight'
    | 'record-unknown'
    | 'index-not-ready'
    | 'index-unavailable'
    | 'linked-elsewhere'
    | 'playing-now'
    | 'playback-unknown'
    | 'unreadable';

export interface ReplaceCandidate {
    id: string;
    notePath: string;
    noteName: string;
    audioPath: string;
    audioName: string;
    /** Size of the audio file, or null when the vault cannot say. */
    audioBytes: number | null;
    from: string;
    to: string;
    /** The days this episode covers (its coverage keys). */
    dates: string[];
    /** Notes other than the episode's own that link to its note or audio. */
    inboundLinks: number;
    meta: EpisodeMeta;
}

export interface ReplaceDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: () => Date;
    /** Test seams. */
    waitForIndex?: (timeoutMs: number) => Promise<WaitResult>;
    probePlaying?: (app: App, audioName: string) => PlaybackProbe;
}

export interface ReplaceAssessment {
    candidates: ReplaceCandidate[];
    refused: Array<{ id: string; reason: RefuseReason }>;
}

const INDEX_WAIT_MS = 10_000;

// ── Assessment ───────────────────────────────────────────────────────────────

/** Sources other than `own` that link to any of `targets` (case-insensitive paths). */
function inboundLinkers(app: App, own: string, targets: readonly string[]): number {
    const table = (app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
    const wanted = new Set(targets.map((t) => t.toLowerCase()));
    const ownKey = own.toLowerCase();
    let count = 0;
    for (const [source, links] of Object.entries(table)) {
        if (source.toLowerCase() === ownKey) continue;
        if (Object.keys(links ?? {}).some((target) => wanted.has(target.toLowerCase()))) count++;
    }
    return count;
}

/**
 * Judge whether these episodes may be replaced RIGHT NOW. One verdict per episode; the caller
 * decides what a refusal means (Replace is all-or-nothing). Never throws: an unreadable input is a
 * refusal, not an assumption.
 *
 * `manual` is judged at the person's own request, who sees and confirms what links will break. `auto`
 * has nobody to confirm, so it also refuses any episode other notes link to (and later layers more).
 * Every episode's dates and audio come from a FRESH read of its note, never from the supplied metadata.
 */
export async function assessReplace(
    deps: ReplaceDeps,
    episodes: readonly EpisodeMeta[],
    purpose: ReplacePurpose,
): Promise<ReplaceAssessment> {
    const { app, plugin, settings } = deps;
    const candidates: ReplaceCandidate[] = [];
    const refused: ReplaceAssessment['refused'] = [];
    const refuseAll = (reason: RefuseReason): ReplaceAssessment => ({ candidates: [], refused: episodes.map((e) => ({ id: e.id, reason })) });

    // Nothing is judged from a partial picture of the vault.
    const waited = await (deps.waitForIndex ? deps.waitForIndex(INDEX_WAIT_MS) : waitForMetadataIndex(app, { timeoutMs: INDEX_WAIT_MS }));
    if (waited.outcome !== 'ready') return refuseAll(waited.state === 'unknown' ? 'index-unavailable' : 'index-not-ready');
    if (!hasLinkTable(app)) return refuseAll('index-unavailable');

    let acks: ReturnType<typeof coerceAcks>;
    let inflight: { opId: string; audioName: string } | null = null;
    try {
        // Read the store directly: `loadPluginData` turns a failed read into "empty", which here would mean
        // "nobody has heard anything and nothing is in flight". An unreadable store must refuse instead.
        const data = ((await plugin.loadData()) ?? {}) as Record<string, unknown>;
        acks = coerceAcks(data[ACKS_DATA_KEY]);
        const status = storedRecordStatus(data[DRAFT_DATA_KEY]);
        if (status === 'unsupported' || status === 'corrupt') return refuseAll('record-unknown');
        const record = status === 'valid' ? coerceRecord(data[DRAFT_DATA_KEY]) : null;
        if (record) inflight = { opId: record.opId, audioName: (record.audio?.path ?? '').split('/').pop() ?? '' };
    } catch (e) {
        logger.warn('Newsletter', 'Replace could not read the listening or operation records', e);
        return refuseAll('acks-unreadable');
    }

    const outputRoot = getNewsletterOutputFullPath(settings);
    const folder = episodeFolderPath(outputRoot);
    const probe = deps.probePlaying ?? probeEpisodePlaying;

    for (const meta of episodes) {
        let verdict: Awaited<ReturnType<typeof judge>>;
        try {
            verdict = await judge(meta);
        } catch (e) {
            logger.warn('Newsletter', `Replace could not assess ${meta.id}`, e);
            verdict = { reason: 'unreadable' };
        }
        if ('reason' in verdict) refused.push({ id: meta.id, reason: verdict.reason });
        else candidates.push(verdict.candidate);
    }
    return { candidates, refused };

    async function judge(meta: EpisodeMeta): Promise<{ candidate: ReplaceCandidate } | { reason: RefuseReason }> {
        const notePath = normalizePath(meta.notePath);
        const file = app.vault.getAbstractFileByPath(notePath);
        const named = parseEpisodeName(notePath.split('/').pop() ?? '');
        // The note: a direct child of <root>/Catch-up/, named for THIS episode, readable and still valid.
        if (!(file instanceof TFile) || !named || named.id !== meta.id) return { reason: 'note-unexpected' };
        if (normalizePath(notePath.slice(0, notePath.lastIndexOf('/'))) !== normalizePath(folder)) return { reason: 'note-unexpected' };
        const fresh = await readEpisodeResult(app, file);
        if (fresh.kind !== 'ok' || fresh.meta.id !== meta.id || fresh.meta.audio !== meta.audio || fresh.meta.audioRemoved) return { reason: 'note-unexpected' };

        // The audio: a bare catch-up file name, a direct child, present.
        if (!isEpisodeAudioName(meta.audio)) return { reason: 'audio-unexpected' };
        const audioPath = normalizePath(`${folder}/${meta.audio}`);
        const audio = app.vault.getAbstractFileByPath(audioPath);
        if (!(audio instanceof TFile)) return { reason: 'audio-unexpected' };
        if (!isInsideOutputRoot(folder, notePath) || !isInsideOutputRoot(folder, audioPath)) return { reason: 'audio-unexpected' };

        if (!assertWritable(settings, 'delete', notePath).ok || !assertWritable(settings, 'delete', audioPath).ok) return { reason: 'protected' };
        if (meta.id in acks) return { reason: 'acked' };
        if (inflight && (inflight.opId === meta.id || inflight.audioName === meta.audio)) return { reason: 'record-in-flight' };

        const playing = probe(app, meta.audio);
        if (playing === 'playing') return { reason: 'playing-now' };
        if (playing === 'unknown') return { reason: 'playback-unknown' };

        const inboundLinks = inboundLinkers(app, notePath, [notePath, audioPath]);
        if (purpose === 'auto' && inboundLinks > 0) return { reason: 'linked-elsewhere' };

        const stat = (audio as { stat?: { size?: number } }).stat;
        return {
            candidate: {
                id: meta.id,
                notePath,
                noteName: notePath.split('/').pop() ?? notePath,
                audioPath,
                audioName: meta.audio,
                audioBytes: typeof stat?.size === 'number' ? stat.size : null,
                from: fresh.meta.from,
                to: fresh.meta.to,
                // From the note as it is NOW: a stale list of days could understate what retiring loses.
                dates: Object.keys(fresh.meta.coverage).sort(),
                inboundLinks,
                meta: fresh.meta,
            },
        };
    }
}

/** Days of the replaced episodes that the replacement would neither re-make nor leave covered elsewhere. */
export function lostDaysOf(candidates: readonly Pick<ReplaceCandidate, 'dates'>[], preview: Pick<CatchUpSnapshot, 'plan' | 'pending'>): string[] {
    const kept = new Set<string>([...(preview.plan?.entries.map((e) => e.date) ?? []), ...preview.pending.coveredDates]);
    const lost = new Set<string>();
    for (const c of candidates) for (const d of c.dates) if (!kept.has(d)) lost.add(d);
    return [...lost].sort();
}

// ── Preparation (what the window shows before anyone confirms) ───────────────

export type ReplacePrep =
    | { kind: 'blocked'; refused: ReplaceAssessment['refused']; nothingToMake?: boolean }
    | {
        kind: 'ready';
        candidates: ReplaceCandidate[];
        /** The exact plan a replacement would make (days, newsletters, length): shown BEFORE any spend. */
        preview: CatchUpSnapshot;
        lostDays: string[];
        /** The frozen target set: the confirmation, the preview and the run all carry exactly these ids. */
        episodeIds: string[];
    };

/**
 * Read-only. Assesses every unheard episode in the window (Replace acts on the full blocker set),
 * and when all are replaceable builds the exclusion preview. Writes nothing and spends nothing.
 */
export async function prepareReplace(deps: ReplaceDeps): Promise<Result<ReplacePrep>> {
    try {
        if (!isFeatureEnabled(deps.settings, 'newsletter') || !isCatchUpEnabled(deps.settings)) return err('catchup-wrong-mode');
        const now = deps.now?.();
        const current = await buildCatchUpSnapshot({ app: deps.app, plugin: deps.plugin, settings: deps.settings, now });
        if (current.unheard.length === 0) return err('catchup-nothing-pending');
        const assessment = await assessReplace(deps, current.unheard, 'manual');
        if (assessment.refused.length > 0) return ok({ kind: 'blocked', refused: assessment.refused });

        const episodeIds = current.unheard.map((e) => e.id).sort();
        const preview = await buildCatchUpSnapshot({ app: deps.app, plugin: deps.plugin, settings: deps.settings, now, excludeEpisodeIds: episodeIds });
        if (!preview.plan) return ok({ kind: 'blocked', refused: [], nothingToMake: true });
        return ok({ kind: 'ready', candidates: assessment.candidates, preview, lostDays: lostDaysOf(assessment.candidates, preview), episodeIds });
    } catch (e) {
        logger.warn('Newsletter', 'Replace could not be prepared', e);
        return err(e instanceof Error ? e.message : String(e));
    }
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface RetiredEpisode {
    id: string;
    /** The files, so a report can name exactly what is still there. */
    noteName: string;
    audioName: string;
    note: 'trashed' | 'kept' | 'failed';
    audio: 'trashed' | 'kept' | 'failed';
    /** Why it was kept or failed. */
    reason?: string;
}

export interface ReplaceOutcome {
    episode: EpisodeResult;
    /** What happened to each old episode, per file: the new episode is saved whatever this says. */
    retired: RetiredEpisode[];
}

export interface ReplaceRequest {
    /** The frozen target set (ids). */
    episodeIds: readonly string[];
    /** The plan hash the person saw in the preview. */
    previewHash: string;
    /** The person confirmed that days which cannot be made again are lost from the audio (their briefs stay). */
    acceptLostDays: boolean;
    purpose: ReplacePurpose;
    run: Pick<RunOptions, 'signal' | 'onPhase' | 'setCancellable' | 'interactive' | 'confirmOverrun'>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Make the replacement, then retire the old episodes, all under ONE single-flight lock.
 *
 *   reconcile -> same blocker set? -> assess -> preview (lost days, hash) -> RUN -> assess again -> trash
 *
 * Errors before the run leave everything untouched. After the run the new episode is saved whatever
 * the retirement does; each old file is reported on its own.
 */
export async function replaceAndRunCatchUp(ports: CatchUpPorts, request: ReplaceRequest, seams: Pick<ReplaceDeps, 'waitForIndex' | 'probePlaying'> = {}): Promise<Result<ReplaceOutcome>> {
    try {
        return await runExclusive<ReplaceOutcome>(async () => {
            const deps: ReplaceDeps = { app: ports.app, plugin: ports.plugin, settings: ports.settings, now: ports.now, ...seams };
            if (!isFeatureEnabled(ports.settings, 'newsletter') || !isCatchUpEnabled(ports.settings)) return err('catchup-wrong-mode');
            const state = await reconcileOperation(ports);
            if (state.kind !== 'none' && state.kind !== 'committed') return err('catchup-unresolved');
            if (!assertEpisodeOutputWritable(ports.settings, getNewsletterOutputFullPath(ports.settings)).ok) return err(OUTPUT_PROTECTED);

            const current = await buildCatchUpSnapshot({ app: ports.app, plugin: ports.plugin, settings: ports.settings, now: ports.now?.() });
            // The blocker set changed since the confirmation: do nothing, the window refreshes.
            if (!sameSet(current.unheard.map((e) => e.id), request.episodeIds)) return err('catchup-changed');

            const assessment = await assessReplace(deps, current.unheard, request.purpose);
            if (assessment.refused.length > 0) {
                logger.warn('Newsletter', `Replace refused: ${assessment.refused.map((r) => `${r.id}:${r.reason}`).join(', ')}`);
                return err('catchup-replace-unsafe');
            }

            const preview = await buildCatchUpSnapshot({ app: ports.app, plugin: ports.plugin, settings: ports.settings, now: ports.now?.(), excludeEpisodeIds: request.episodeIds });
            if (!preview.plan || preview.plan.planHash !== request.previewHash) return err('catchup-changed');
            const lost = lostDaysOf(assessment.candidates, preview);
            if (lost.length > 0 && (request.purpose === 'auto' || !request.acceptLostDays)) return err('catchup-replace-unsafe');

            const made = await runCatchUpLocked(ports, {
                ...request.run,
                excludeEpisodeIds: request.episodeIds,
                previewHash: request.previewHash,
                kind: request.purpose === 'auto' ? 'auto' : 'manual',
            });
            if (!made.ok) return made;

            // The replacement is committed: nothing below may turn that into a failure. Retire the old
            // episodes, each judged AGAIN just now, and report whatever happens per file.
            const retired: RetiredEpisode[] = [];
            await retire(deps, assessment.candidates, request.purpose, retired);
            try { ports.onChanged?.(); } catch (e) { logger.warn('Newsletter', 'Replace change listener failed', e); }
            return ok({ episode: made.value, retired });
        });
    } catch (e) {
        logger.warn('Newsletter', 'Replace failed', e);
        return err(e instanceof Error ? e.message : String(e));
    }
}

/**
 * Trash each old episode's note then its audio, but only if it is STILL safe to. Never throws: each row
 * is recorded BEFORE anything is done to it and updated in place, so whatever goes wrong the report
 * still matches what is on disk. `out` is the caller's, so a failure part-way keeps the rows so far.
 */
async function retire(deps: ReplaceDeps, candidates: readonly ReplaceCandidate[], purpose: ReplacePurpose, out: RetiredEpisode[]): Promise<void> {
    const outputRoot = getNewsletterOutputFullPath(deps.settings);
    const probe = deps.probePlaying ?? probeEpisodePlaying;
    for (const c of candidates) {
        const row: RetiredEpisode = { id: c.id, noteName: c.noteName, audioName: c.audioName, note: 'kept', audio: 'kept' };
        out.push(row);
        try {
            const again = await assessReplace(deps, [c.meta], purpose);
            if (again.refused.length > 0) { row.reason = again.refused[0].reason; continue; }

            // Note first: a failed audio trash then leaves an inert orphan file, never a stale note
            // that offers to regenerate audio the reader just replaced.
            try {
                row.note = (await trashOwnedFile(deps.app, outputRoot, c.notePath)) ? 'trashed' : 'failed';
            } catch (e) {
                row.note = 'failed';
                row.reason = e instanceof Error ? e.message : String(e);
                logger.warn('Newsletter', `Replace could not trash ${c.notePath}`, e);
            }
            if (row.note !== 'trashed') continue;

            // Judged again right before THIS trash: the note's removal is not instant, and playback may have begun.
            const playing = probe(deps.app, c.audioName);
            if (playing !== 'idle') { row.reason = playing === 'playing' ? 'playing-now' : 'playback-unknown'; continue; }
            try {
                row.audio = (await trashOwnedFile(deps.app, outputRoot, c.audioPath)) ? 'trashed' : 'failed';
            } catch (e) {
                row.audio = 'failed';
                row.reason = e instanceof Error ? e.message : String(e);
                logger.warn('Newsletter', `Replace could not trash ${c.audioPath}`, e);
            }
        } catch (e) {
            // Anything unexpected: what is already done stays reported as done; the rest as not done.
            logger.warn('Newsletter', `Replace could not finish retiring ${c.id}`, e);
            row.reason = row.reason ?? 'unreadable';
            if (row.note === 'trashed' && row.audio === 'kept') row.audio = 'failed';
        }
    }
}
