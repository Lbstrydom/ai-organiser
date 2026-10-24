/**
 * Catch-up tidy — remove the daily audio a catch-up episode has superseded.
 *
 * Installs that used Daily audio keep a recording per day, embedded at the top of each day's digest.
 * Once a catch-up episode narrates those days in full, the recordings are redundant. The tidy:
 *
 *  - acts only on the files the person CONSENTED to (the checkbox showed their count and size), and
 *    only to VALIDATE them again; it never goes looking for more to remove;
 *  - only after the episode is COMMITTED, and only for days the committed note really covers;
 *  - writes the digest first (the dead embed becomes a plain "Audio removed" line) and trashes the
 *    audio second, so a failed edit leaves the audio and a failed trash leaves an inert file;
 *  - fails closed on everything unknown: an index that is not ready, a file or brief that changed since
 *    consent, a link from anywhere else, a protected folder, a vault change while it runs.
 *
 * The written brief of every day stays. Nothing here is permanent deletion: files go to the user's trash.
 */

import { TFile, normalizePath, type App, type Plugin } from 'obsidian';
import { ok, err, type Result } from '../../../core/result';
import { assertWritable } from '../../../core/protectedPaths';
import { getNewsletterOutputFullPath, type AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { waitForMetadataIndex, type WaitResult } from '../../../utils/metadataIndexState';
import { isFeatureEnabled } from '../../featureService';
import { isCatchUpEnabled } from '../newsletterAudioMode';
import { extractBriefFromDigest } from '../newsletterService';
import { fnv1a } from './catchUpCoverage';
import { generatedEmbedLines } from './catchUpDailyEmbed';
import { hasLinkTable, trackChanges } from './catchUpCleanup';
import { findEpisodeByOpId, isInsideOutputRoot, trashOwnedFile } from './catchUpEpisode';
import { runExclusive } from './catchUpService';
import type { TidyFile } from './catchUpTypes';

// ── Types ────────────────────────────────────────────────────────────────────

export type TidySkipReason =
    | 'not-covered'
    | 'changed-since-consent'
    | 'embed-missing'
    | 'linked-elsewhere'
    | 'protected'
    | 'outside-day-folder'
    | 'unclassified-reference'
    | 'write-failed'
    | 'trash-failed'
    | 'digest-unreadable'
    | 'unreadable';

export interface TidyDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: () => Date;
    /** Compare-and-commit note write (the plugin's applyNoteEdit); a baseline mismatch is an error. */
    writeNote: (path: string, baseline: string, next: string) => Promise<Result<void>>;
    /** The sentence that replaces the dead embed, e.g. "Audio removed on 2026-10-24". */
    removedLine: (date: string) => string;
    /** Test seam: wait for the link index. Defaults to the real, cancellable wait. */
    waitForIndex?: (timeoutMs: number) => Promise<WaitResult>;
}

export interface TidyReport {
    removedFiles: number;
    removedBytes: number;
    /** Days whose digest was rewritten and whose audio is gone. */
    daysDone: string[];
    /** Files left in place, each with the reason. */
    skipped: Array<{ name: string; reason: TidySkipReason }>;
    /** Why the tidy stopped early (the vault changed under it), or null. */
    halted: 'changed-during-tidy' | null;
}

export type TidyOutcome =
    | { kind: 'done'; report: TidyReport }
    | { kind: 'skipped'; reason: 'busy' | 'index-not-ready' | 'index-unavailable' | 'episode-missing' | 'off' };

const INDEX_WAIT_MS = 10_000;

// ── Pure: rewrite the digest ─────────────────────────────────────────────────


/**
 * The digest's text after the dead embed of one of `names` is replaced by a plain line. Only the exact
 * generated shape is rewritten ("🎧 **Listen:** ![[brief-….mp3]]", a bare file name as the plugin writes
 * it), and only when there is EXACTLY ONE such line: a copied or second listen line is not ours to
 * judge. Anything that still names a file afterwards fails the whole rewrite, so nothing is written
 * or trashed on a guess.
 */
export function replaceDailyEmbedText(content: string, names: readonly string[], removedText: string): Result<string> {
    if (names.length === 0) return err('unclassified-reference');
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    // EXACTLY ONE generated line outside code, and it must name one of ours: a second, copied or
    // example line is not ours to judge.
    const lines = generatedEmbedLines(content);
    if (lines.length !== 1 || !wanted.has(lines[0].name.toLowerCase())) return err('unclassified-reference');
    const [line] = lines;
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const hadEol = content.slice(line.start, line.end).endsWith('\n');
    const next = content.slice(0, line.start) + `🎧 **Listen:** ${removedText}${hadEol ? eol : ''}` + content.slice(line.end);
    const lower = next.toLowerCase();
    if (names.some((n) => lower.includes(n.toLowerCase()))) return err('unclassified-reference');
    return ok(next);
}

// ── The tidy ─────────────────────────────────────────────────────────────────

const bump = (r: TidyReport, file: TidyFile, reason: TidySkipReason): void => { r.skipped.push({ name: file.name, reason }); };

/**
 * Tidy the consented daily audio. Never throws: every failure is a skipped file or a skipped outcome.
 * `episodeId` is the COMMITTED catch-up episode that supersedes them.
 */
export async function runDailyAudioTidy(deps: TidyDeps, input: { files: readonly TidyFile[]; episodeId: string }): Promise<Result<TidyOutcome>> {
    try {
        if (input.files.length === 0 || !isFeatureEnabled(deps.settings, 'newsletter') || !isCatchUpEnabled(deps.settings)) return ok({ kind: 'skipped', reason: 'off' });
        const locked = await runExclusive<TidyOutcome>(() => tidy(deps, input.files, input.episodeId));
        if (!locked.ok && locked.error === 'catchup-busy') return ok({ kind: 'skipped', reason: 'busy' });
        return locked;
    } catch (e) {
        logger.warn('Newsletter', 'Daily audio tidy failed', e);
        return err(e instanceof Error ? e.message : String(e));
    }
}

async function tidy(deps: TidyDeps, consented: readonly TidyFile[], episodeId: string): Promise<Result<TidyOutcome>> {
    const { app, settings } = deps;
    const outputRoot = getNewsletterOutputFullPath(settings);

    const waited = await (deps.waitForIndex ? deps.waitForIndex(INDEX_WAIT_MS) : waitForMetadataIndex(app, { timeoutMs: INDEX_WAIT_MS }));
    if (waited.outcome !== 'ready') return ok({ kind: 'skipped', reason: waited.state === 'unknown' ? 'index-unavailable' : 'index-not-ready' });
    if (!hasLinkTable(app)) return ok({ kind: 'skipped', reason: 'index-unavailable' });

    // The days the committed episode really covers: re-read from the note, never taken from the plan.
    const episode = await findEpisodeByOpId(app, outputRoot, episodeId);
    if (!episode) return ok({ kind: 'skipped', reason: 'episode-missing' });

    const report: TidyReport = { removedFiles: 0, removedBytes: 0, daysDone: [], skipped: [], halted: null };
    const tracker = trackChanges(app);
    try {
        const byDay = new Map<string, TidyFile[]>();
        for (const f of consented) byDay.set(f.date, [...(byDay.get(f.date) ?? []), f]);
        const today = (deps.now ?? (() => new Date()))();
        const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        for (const [date, files] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
            if (tracker.isDirty()) { report.halted = 'changed-during-tidy'; for (const f of files) bump(report, f, 'unreadable'); continue; }
            const reason = await tidyDay(deps, outputRoot, date, files, episode.coverage, stamp, tracker, report);
            if (reason) for (const f of files) bump(report, f, reason);
        }
        // Anything not reached because the vault changed is reported, not forgotten.
        return ok({ kind: 'done', report });
    } finally {
        tracker.dispose();
    }
}

/** One day: validate, rewrite the digest, then trash the audio. Returns a skip reason, or null when done. */
async function tidyDay(
    deps: TidyDeps,
    outputRoot: string,
    date: string,
    files: readonly TidyFile[],
    coverage: Record<string, unknown>,
    stamp: string,
    tracker: ReturnType<typeof trackChanges>,
    report: TidyReport,
): Promise<TidySkipReason | null> {
    const { app, settings } = deps;
    if (!(date in coverage)) return 'not-covered';

    const dayFolder = normalizePath(`${outputRoot}/${date}`);
    const digestPath = files[0].digestPath;
    if (!files.every((f) => f.digestPath === digestPath)) return 'unreadable';

    // The files: still exactly what was consented to.
    const live: Array<{ file: TFile; consent: TidyFile }> = [];
    for (const consent of files) {
        const file = app.vault.getAbstractFileByPath(normalizePath(consent.path));
        if (!(file instanceof TFile)) return 'changed-since-consent';
        if (!isInsideOutputRoot(dayFolder, file.path) || file.path.split('/').slice(0, -1).join('/') !== dayFolder) return 'outside-day-folder';
        const stat = (file as { stat?: { size?: number; mtime?: number } }).stat;
        if ((stat?.size ?? 0) !== consent.bytes || (stat?.mtime ?? 0) !== consent.mtime) return 'changed-since-consent';
        live.push({ file, consent });
    }
    // A recording that narrated MORE than the episode covers must stay.
    const rev = coverage[date] as { kind?: string; rev?: number } | undefined;
    if (rev?.kind === 'revision' && typeof rev.rev === 'number' && live.some((l) => l.consent.narratedRev !== null && l.consent.narratedRev > (rev.rev as number))) return 'changed-since-consent';

    const digest = app.vault.getAbstractFileByPath(normalizePath(digestPath));
    if (!(digest instanceof TFile)) return 'digest-unreadable';
    if (!assertWritable(settings, 'modify', digest.path).ok || live.some((l) => !assertWritable(settings, 'delete', l.file.path).ok)) return 'protected';

    // Nothing else may link to the recordings: the day's own digest is the only referrer.
    const links = (app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
    const wanted = new Set(live.map((l) => l.file.path.toLowerCase()));
    for (const [source, targets] of Object.entries(links)) {
        if (source.toLowerCase() === digest.path.toLowerCase()) continue;
        if (Object.keys(targets ?? {}).some((t) => wanted.has(t.toLowerCase()))) return 'linked-elsewhere';
    }

    let fresh: string;
    try {
        fresh = await app.vault.read(digest);
    } catch (e) {
        logger.warn('Newsletter', `Tidy could not read ${digest.path}`, e);
        return 'digest-unreadable';
    }
    // The brief the person's episode narrated must be the brief they consented about.
    if (fnv1a(extractBriefFromDigest(fresh)) !== files[0].briefHash) return 'changed-since-consent';
    if (tracker.isDirty()) { report.halted = 'changed-during-tidy'; return 'unreadable'; }

    const rewritten = replaceDailyEmbedText(fresh, live.map((l) => l.consent.name), deps.removedLine(stamp));
    if (!rewritten.ok) return rewritten.error === 'unclassified-reference' && !live.every((l) => fresh.toLowerCase().includes(l.consent.name.toLowerCase())) ? 'embed-missing' : 'unclassified-reference';

    // Digest FIRST: a failed edit leaves the audio exactly where it was.
    const revoke = tracker.expectNoteWrite(digest.path);
    let written: Result<void>;
    try {
        written = await deps.writeNote(digest.path, fresh, rewritten.value);
    } catch (e) {
        written = err(e instanceof Error ? e.message : String(e));
    }
    if (!written.ok) {
        revoke();
        report.halted = 'changed-during-tidy';
        logger.warn('Newsletter', `Tidy could not update ${digest.path}: ${written.error}`);
        return 'write-failed';
    }

    // Then the audio, one file at a time. The write above was asynchronous, so every precondition is
    // judged AGAIN just before each trash; a file that fails is left as an inert file with no embed.
    let anyFailed = false;
    for (const { file, consent } of live) {
        try {
            const stat = (file as { stat?: { size?: number; mtime?: number } }).stat;
            const stillSafe = !tracker.isDirty()
                && app.vault.getAbstractFileByPath(file.path) === file
                && (stat?.size ?? 0) === consent.bytes && (stat?.mtime ?? 0) === consent.mtime
                && assertWritable(settings, 'delete', file.path).ok;
            if (!stillSafe) {
                anyFailed = true;
                if (tracker.isDirty()) report.halted = 'changed-during-tidy';
                bump(report, consent, 'changed-since-consent');
                continue;
            }
            if (await trashOwnedFile(app, outputRoot, file.path)) {
                report.removedFiles++;
                report.removedBytes += consent.bytes;
            } else {
                anyFailed = true;
                bump(report, consent, 'trash-failed');
            }
        } catch (e) {
            anyFailed = true;
            bump(report, consent, 'trash-failed');
            logger.warn('Newsletter', `Tidy could not trash ${file.path}`, e);
        }
    }
    if (!anyFailed) report.daysDone.push(date);
    return null;
}
