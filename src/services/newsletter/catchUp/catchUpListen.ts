/**
 * Catch-up listening — what "heard" means, and what hearing an episode registers.
 *
 * Generated is not heard. An episode counts as heard when the reader plays it (the host's
 * played-ranges signal), runs Mark listened, or runs Mark caught up. Hearing writes two things:
 *
 *  - the DURABLE ack — always, even with story memory off, because it is the authority on
 *    whether an episode was heard (the watermark expires and may not exist);
 *  - the story-memory watermark — only when memory is on, and only at the revisions the episode
 *    was rendered from (its frozen coverage), never the bucket's current revision, so stories
 *    that arrived after the episode was made stay unheard.
 */

import { normalizePath, type App, type Plugin } from 'obsidian';
import { ok, err, type Result } from '../../../core/result';
import type { AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { isStoryMemoryEnabled } from '../newsletterMemoryPolicy';
import { markBucketsConsumed } from '../newsletterConsumption';
import { getBucketDateStr } from '../newsletterService';
import { effectiveLookbackDays, parseEpisodeName, windowDates } from './catchUpCoverage';
import { ackEpisodes } from './catchUpDraft';
import { episodeFolderPath, findEpisodeByOpId, isInsideOutputRoot, loadEpisodes } from './catchUpEpisode';
import type { EpisodeMeta } from './catchUpTypes';
import { getNewsletterOutputFullPath } from '../../../core/settings';

const CATCHUP_AUDIO_RE = /^catchup-.+\.mp3$/i;

export interface CatchUpAudioResolution {
    /** Episode id parsed from the note's NAME; the caller must still verify it against the note's frontmatter. */
    episodeId: string;
    audioBasename: string;
}

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

function canonicalise(path: string): string {
    // Strip query/fragment BEFORE decoding (a legitimately encoded %3F must not become a real ?).
    return safeDecode(path.replace(/[?#].*$/, '')).replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/').replace(/^\//, '').trim();
}

/**
 * Pure: is this played `<audio>` a catch-up episode, and whose? Returns null for anything else
 * (the common case: daily audio, narration, recordings). An authority check, not a guess — the
 * source note must sit inside `<root>/Catch-up/` and be named like an episode.
 */
export function resolveCatchUpAudio(input: { sourcePath: string; audioSrc: string; outputRoot: string }): CatchUpAudioResolution | null {
    const sourcePath = canonicalise(input.sourcePath ?? '');
    const audioPath = canonicalise(input.audioSrc ?? '');
    if (sourcePath === '' || audioPath === '') return null;

    const audioBasename = audioPath.split('/').pop() ?? '';
    if (!CATCHUP_AUDIO_RE.test(audioBasename)) return null;

    const folder = episodeFolderPath(input.outputRoot);
    if (!isInsideOutputRoot(folder, sourcePath) || sourcePath === folder) return null;
    const named = parseEpisodeName(sourcePath.split('/').pop() ?? '');
    if (!named) return null;
    // The note must be a DIRECT child of the Catch-up folder.
    if (normalizePath(sourcePath.slice(0, sourcePath.lastIndexOf('/'))) !== normalizePath(folder)) return null;

    return { episodeId: named.id, audioBasename };
}

export interface ListenDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: Date;
}

function todayOf(settings: AIOrganiserSettings, now: Date): string {
    return getBucketDateStr(now, settings.newsletterBriefCutoffHour ?? 6, settings.newsletterBriefCutoffMinute ?? 0);
}

/** Register that an episode was heard. Idempotent: replaying one writes nothing new. */
export async function markEpisodeListened(deps: ListenDeps, episode: Pick<EpisodeMeta, 'id' | 'to' | 'coverage'>): Promise<Result<{ acked: boolean; buckets: number }>> {
    try {
        const now = deps.now ?? new Date();
        const today = todayOf(deps.settings, now);
        const lookback = effectiveLookbackDays(deps.settings.newsletterCatchUpLookbackDays, deps.settings.newsletterRetentionDays ?? 30);

        const acked = (await ackEpisodes(deps.plugin, [{ id: episode.id, to: episode.to }], today, lookback)) > 0;

        let buckets = 0;
        if (isStoryMemoryEnabled(deps.settings)) {
            const entries = Object.entries(episode.coverage)
                .flatMap(([date, cov]) => (cov.kind === 'revision' ? [{ date, revision: cov.rev }] : []));
            buckets = await markBucketsConsumed(deps.plugin, entries, 'catchup', today);
        }
        return ok({ acked, buckets });
    } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
    }
}

/**
 * The host playback signal for a played audio element. Resolves it to an episode (pure
 * resolver, then verified against the note's own frontmatter) and registers it as heard.
 * Returns ok(false) for anything that is not a catch-up episode.
 */
export async function markCatchUpAudioPlayed(deps: ListenDeps, input: { sourcePath: string; audioSrc: string }): Promise<Result<boolean>> {
    try {
        const outputRoot = getNewsletterOutputFullPath(deps.settings);
        const resolved = resolveCatchUpAudio({ ...input, outputRoot });
        if (!resolved) return ok(false);

        const episode = await findEpisodeByOpId(deps.app, outputRoot, resolved.episodeId);
        // The authority check: the note's own record must name THIS audio file.
        if (!episode || episode.audio !== resolved.audioBasename) {
            logger.warn('Newsletter', `Played catch-up audio "${resolved.audioBasename}" does not match its note — not marking heard`);
            return ok(false);
        }
        const res = await markEpisodeListened(deps, episode);
        return res.ok ? ok(res.value.acked || res.value.buckets > 0) : res;
    } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
    }
}

/**
 * Mark caught up: the reader asserts they are up to date, so every in-window episode counts as
 * heard. Acks only — the watermark side is already done by the existing mark-caught-up for the
 * buckets it covers.
 */
export async function ackAllInWindowEpisodes(deps: ListenDeps): Promise<number> {
    const now = deps.now ?? new Date();
    const today = todayOf(deps.settings, now);
    const lookback = effectiveLookbackDays(deps.settings.newsletterCatchUpLookbackDays, deps.settings.newsletterRetentionDays ?? 30);
    const outputRoot = getNewsletterOutputFullPath(deps.settings);
    const { episodes } = await loadEpisodes(deps.app, outputRoot, windowDates(today, lookback)[0]);
    return ackEpisodes(deps.plugin, episodes.map((e) => ({ id: e.id, to: e.to })), today, lookback);
}
