/**
 * Catch-up selection — read the vault, decide what is pending, freeze it.
 *
 * Gathers the facts (digests in the window, ledger revisions, episode notes, legacy daily
 * audio) and hands them to the PURE rules in `catchUpCoverage.ts`. Reading only: nothing in
 * this module writes, so it is safe to call for a preview, a status-bar refresh or a plan.
 */

import { App, normalizePath, TFile, type Plugin } from 'obsidian';
import type { AIOrganiserSettings } from '../../../core/settings';
import { getNewsletterOutputFullPath } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { loadLedger } from '../newsletterStoryLedger';
import { consumedRevision, loadConsumption } from '../newsletterConsumption';
import { isStoryMemoryEnabled } from '../newsletterMemoryPolicy';
import {
    extractBriefFromDigest,
    getBucketDateStr,
    getDigestPath,
    isBucketClosed,
} from '../newsletterService';
import type { ConsumptionState, StoryLedger } from '../newsletterMemoryTypes';
import {
    computePending,
    coverageSignature,
    deriveCaughtUpState,
    deriveCoverage,
    effectiveLookbackDays,
    fnv1a,
    expiringPending,
    legacyHeard,
    lengthPlan,
    unheardEpisodes,
    windowDates,
} from './catchUpCoverage';
import { findLatestEpisode, findLatestNarratedEpisode, loadEpisodes } from './catchUpEpisode';
import { loadAcks } from './catchUpDraft';
import { generatedEmbedLines } from './catchUpDailyEmbed';
import type {
    BucketInfo,
    CatchUpPlan,
    CatchUpPlanEntry,
    CaughtUpState,
    Coverage,
    EpisodeMeta,
    PendingResult,
    PendingRunKind,
    SkippedDay,
    TidyFile,
    TidyPlan,
} from './catchUpTypes';

/** A brief shorter than this is not worth narrating (same floor the daily audio uses). */
const MIN_BRIEF_CHARS = 50;

export interface SelectionDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: Date;
    /**
     * "Include again": treat these dates as never covered (episode AND legacy coverage ignored)
     * so they are re-offered in full at their current briefs. The new episode's coverage then
     * supersedes the old by the normal max-merge.
     */
    forceDates?: readonly string[];
    /**
     * Replace preview: treat these episodes as if they did not exist for COVERAGE (their days become
     * pending again), so the plan shows exactly what a replacement would make. Read-only; the episodes
     * stay in `unheard`/`episodes`, nothing is touched.
     */
    excludeEpisodeIds?: readonly string[];
}

/** Everything the modal, the status bar and the generator need to know, from one read pass. */
export interface CatchUpSnapshot {
    today: string;
    window: string[];
    memoryOn: boolean;
    outputRoot: string;
    pending: PendingResult;
    state: CaughtUpState;
    /** The frozen plan, or null when nothing is actionable. */
    plan: CatchUpPlan | null;
    episodes: EpisodeMeta[];
    /** In-window episodes whose audio file is gone (offered for regeneration). */
    missingAudio: EpisodeMeta[];
    unheard: EpisodeMeta[];
    latestEpisode: EpisodeMeta | null;
    oldestStoredDate: string | null;
    /** Pending days whose digest retention will prune within two days. */
    expiringDates: string[];
    /** Window days left out of the plan on purpose, with the reason, so the window can say so. */
    skipped: SkippedDay[];
    /** Window days with a digest note but no usable daily brief (a subset of `pending.noStoredDates`). */
    noBriefDates: string[];
    /**
     * The listening record could not be read, so no daily audio counted as heard. The window says so
     * and the automatic run holds back: a person may choose to generate anyway, an unattended run may not.
     */
    evidenceDegraded: boolean;
    /**
     * How many days an AUTOMATIC run would cover right now (closed days only). The waiting message
     * quotes this, not the window headline, because an open day is not something Smart daily is waiting to make.
     */
    autoPendingDays: number;
    /** Daily audio files this catch-up would make redundant, or null when there are none. */
    tidy: TidyPlan | null;
}

export function tidyPlanOf(files: readonly TidyFile[]): TidyPlan | null {
    if (files.length === 0) return null;
    return { files: [...files], bytes: files.reduce((n, f) => n + f.bytes, 0), days: [...new Set(files.map((f) => f.date))].sort() };
}

/** Story titles from a brief's bullet lines: `- **Title**: text`. */
export function titlesFromBrief(brief: string): string[] {
    const out: string[] = [];
    for (const m of brief.matchAll(/^\s*[-*]\s+\*\*(.+?)\*\*/gm)) out.push(m[1].trim());
    return out;
}

/** Count the newsletters a digest links to for its day (`[[YYYY-MM-DD/…]]`). */
export function countDigestSources(digest: string, date: string): number {
    const seen = new Set<string>();
    for (const m of digest.matchAll(new RegExp(String.raw`\[\[${date}/([^\]|]+)`, 'g'))) seen.add(m[1].replace(/\.md$/, ''));
    return seen.size;
}

/**
 * Coverage a bucket already has from the LEGACY daily audio — by provenance only.
 *
 * The embed text alone proves nothing (it can outlive the file, or describe an older version
 * of an advanced bucket). A recorded ledger revision for an audio file that still exists gives
 * `revision(max)`; an audio file that exists without surviving provenance gives `whole`
 * (the day was narrated at some version we can no longer name); nothing gives null.
 */
export function legacyCoverageFor(date: string, audioFileNames: readonly string[], ledgerAudio: Record<string, number> | undefined): Coverage | null {
    const pattern = new RegExp(String.raw`^brief-${date}-[a-f0-9]{8}\.(?:mp3|wav)$`);
    const names = audioFileNames.filter((n) => pattern.test(n));
    if (names.length === 0) return null;
    const revs = names.map((n) => {
        const r = ledgerAudio?.[n];
        return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
    });
    // One surviving recording whose provenance is gone could have narrated ANY version of the day.
    // The conservative reading — never re-tell a story, accept missing a late one — is `whole`.
    if (revs.some((r) => r === null)) return { kind: 'whole' };
    return { kind: 'revision', rev: Math.max(...(revs as number[])) };
}

function fileNamesIn(app: App, folderPath: string): string[] {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!folder || !('children' in folder)) return [];
    return (folder as { children: unknown[] }).children.filter((c): c is TFile => c instanceof TFile).map((f) => f.name);
}

interface DayFacts {
    info: BucketInfo;
    /** The day has a digest note (it may still hold no usable daily brief). */
    digestExists: boolean;
    brief: string;
    newsletters: number;
    /** Daily audio files this day still holds that its digest embeds (the only ones a tidy may ever touch). */
    dailyAudio: TidyFile[];
}

/** Bare file names the digest embeds through the generated listen line, outside code blocks (see `catchUpDailyEmbed`). */
export function embeddedDailyAudioNames(digest: string): Set<string> {
    return new Set(generatedEmbedLines(digest).map((l) => l.name.toLowerCase()));
}

/** The day's daily audio files that match the naming contract AND are embedded by its digest. */
function dailyAudioFor(app: App, folderPath: string, date: string, digestPath: string, digest: string, brief: string, audioMap: Record<string, number> | undefined): TidyFile[] {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!folder || !('children' in folder)) return [];
    const pattern = new RegExp(String.raw`^brief-${date}-[a-f0-9]{8}\.(?:mp3|wav)$`);
    const embedded = embeddedDailyAudioNames(digest);
    const briefHash = fnv1a(brief);
    const out: TidyFile[] = [];
    for (const child of (folder as { children: unknown[] }).children) {
        if (!(child instanceof TFile) || !pattern.test(child.name) || !embedded.has(child.name.toLowerCase())) continue;
        const stat = (child as { stat?: { size?: number; mtime?: number } }).stat;
        const rev = audioMap?.[child.name];
        out.push({
            date, name: child.name, path: child.path, digestPath, briefHash,
            bytes: typeof stat?.size === 'number' ? stat.size : 0,
            mtime: typeof stat?.mtime === 'number' ? stat.mtime : 0,
            narratedRev: typeof rev === 'number' && Number.isInteger(rev) && rev >= 1 ? rev : null,
        });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function readDay(
    app: App,
    outputRoot: string,
    date: string,
    ledger: StoryLedger | null,
    consumption: ConsumptionState | null,
    closed: boolean,
): Promise<DayFacts> {
    const digestPath = getDigestPath(outputRoot, date);
    const digest = app.vault.getAbstractFileByPath(digestPath);
    let brief = '';
    let newsletters = 0;
    let dailyAudio: TidyFile[] = [];
    if (digest instanceof TFile) {
        try {
            const content = await app.vault.cachedRead(digest);
            brief = extractBriefFromDigest(content);
            newsletters = countDigestSources(content, date);
            dailyAudio = dailyAudioFor(app, normalizePath(`${outputRoot}/${date}`), date, digestPath, content, brief, ledger?.buckets[date]?.audio);
        } catch (e) {
            logger.warn('Newsletter', `Catch-up could not read the digest for ${date}`, e);
        }
    }
    const bucket = ledger?.buckets[date];
    const info: BucketInfo = {
        date,
        hasBrief: brief.length >= MIN_BRIEF_CHARS,
        closed,
        revision: bucket && bucket.revision >= 1 ? bucket.revision : null,
        parseFailed: bucket?.parseFailedAt !== undefined,
        // A daily audio is coverage only where the reader HEARD it (their consumption watermark): existing is not heard.
        legacy: legacyHeard(
            legacyCoverageFor(date, fileNamesIn(app, normalizePath(`${outputRoot}/${date}`)), bucket?.audio),
            consumption ? consumedRevision(consumption, date) : null,
            consumption !== null,
        ),
    };
    return { info, brief, newsletters, dailyAudio, digestExists: digest instanceof TFile };
}

/** Itemise the late additions of a delta bucket from the ledger: stories newer than `since`. */
function deltaText(ledger: StoryLedger | null, date: string, since: number): { text: string; titles: string[] } {
    const stories = (ledger?.buckets[date]?.stories ?? []).filter((s) => s.contentRevision > since);
    return {
        text: stories.map((s) => `- **${s.title}**: ${s.gist}`).join('\n'),
        titles: stories.map((s) => s.title),
    };
}

/**
 * One read pass over the vault: what is pending, what the next episode would look like, and
 * what the reader has not yet heard. Never throws on a missing/corrupt input — it degrades
 * to "nothing known" for that input and logs.
 */
export async function buildCatchUpSnapshot(deps: SelectionDeps, kind: PendingRunKind = 'manual'): Promise<CatchUpSnapshot> {
    const { app, plugin, settings } = deps;
    const now = deps.now ?? new Date();
    const hour = settings.newsletterBriefCutoffHour ?? 6;
    const minute = settings.newsletterBriefCutoffMinute ?? 0;
    const outputRoot = getNewsletterOutputFullPath(settings);
    const memoryOn = isStoryMemoryEnabled(settings);

    const today = getBucketDateStr(now, hour, minute);
    const lookback = effectiveLookbackDays(settings.newsletterCatchUpLookbackDays, settings.newsletterRetentionDays ?? 30);
    const window = windowDates(today, lookback);

    let ledger: StoryLedger | null = null;
    let consumption: ConsumptionState | null = null;
    let evidenceDegraded = false;
    if (memoryOn) {
        try { ledger = await loadLedger(plugin); } catch (e) {
            logger.warn('Newsletter', 'Catch-up could not read story memory — treating revisions as unknown', e);
        }
        // Without the listening record there is no evidence any daily audio was heard: those days are offered.
        try { consumption = await loadConsumption(plugin); } catch (e) {
            logger.warn('Newsletter', 'Catch-up could not read what you have listened to — daily audio will not count as heard', e);
            evidenceDegraded = true;
        }
    }

    const [{ episodes, missingAudio }, acks, latestEpisode, latestNarrated] = await Promise.all([
        loadEpisodes(app, outputRoot, window[0]),
        loadAcks(plugin),
        findLatestEpisode(app, outputRoot),
        findLatestNarratedEpisode(app, outputRoot),
    ]);

    const days = new Map<string, DayFacts>();
    for (const date of window) {
        days.set(date, await readDay(app, outputRoot, date, ledger, consumption, isBucketClosed(date, hour, now, minute)));
    }

    const forced = new Set(deps.forceDates ?? []);
    const buckets = Object.fromEntries([...days].map(([d, f]) => [d, forced.has(d) ? { ...f.info, legacy: null } : f.info]));
    const excluded = new Set(deps.excludeEpisodeIds ?? []);
    const coverage = deriveCoverage(excluded.size === 0 ? episodes : episodes.filter((e) => !excluded.has(e.id)));
    for (const d of forced) delete coverage[d];
    const pending = computePending({
        window,
        buckets,
        coverage,
        // Revisions are only trustworthy when the ledger actually loaded.
        memoryOn: memoryOn && ledger !== null,
        kind,
    });

    // Days left out on purpose, so the window can say so instead of silently shrinking.
    const skipped: SkippedDay[] = [];
    for (const d of pending.coveredDates) {
        if (!coverage[d] && days.get(d)?.info.legacy) skipped.push({ date: d, reason: 'heard-daily-audio' });
    }
    for (const d of pending.openDates) skipped.push({ date: d, reason: 'open-day' });
    skipped.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Daily audio the episode would supersede: files of days it narrates IN FULL (a delta day was covered earlier).
    const tidy = tidyPlanOf(pending.entries.filter((e) => e.kind === 'full').flatMap((e) => days.get(e.date)?.dailyAudio ?? []));

    const oldestStoredDate = window.find((d) => days.get(d)?.info.hasBrief) ?? null;

    // A delta whose late additions cannot be itemised into text is unresolved, never silently dropped.
    const itemise = (result: PendingResult): { entries: CatchUpPlanEntry[]; unresolved: PendingResult['unresolved'] } => {
        const out: CatchUpPlanEntry[] = [];
        const unresolvedOut = [...result.unresolved];
        for (const e of result.entries) {
            const facts = days.get(e.date) as DayFacts;
            const body = e.kind === 'delta'
                ? deltaText(ledger, e.date, e.sinceRevision ?? 0)
                : { text: facts.brief, titles: titlesFromBrief(facts.brief) };
            if (body.text.trim() === '') { unresolvedOut.push({ date: e.date, reason: 'unitemisable' }); continue; }
            out.push({ ...e, text: body.text, newsletters: facts.newsletters, titles: body.titles });
        }
        return { entries: out, unresolved: unresolvedOut };
    };
    const { entries, unresolved } = itemise(pending);
    const resolved: PendingResult = { ...pending, entries, unresolved };

    // What an unattended run would cover: the same pure rule, closed days only.
    const autoPendingDays = kind === 'auto'
        ? entries.length
        : itemise(computePending({ window, buckets, coverage, memoryOn: memoryOn && ledger !== null, kind: 'auto' })).entries.length;

    // "Since the last audio" is where the last NARRATED range ended, not which file was made last.
    const state = deriveCaughtUpState({ pending: resolved, latestEpisodeTo: latestNarrated?.to ?? null, oldestStoredDate });
    const unheard = unheardEpisodes(episodes, acks, window[0]);

    const plan: CatchUpPlan | null = entries.length === 0 ? null : {
        entries,
        unresolved,
        noStoredDates: pending.noStoredDates,
        windowDates: window,
        length: lengthPlan(entries.length, settings.newsletterCatchUpMaxMins),
        from: entries[0].date,
        to: entries[entries.length - 1].date,
        createdAt: now.getTime(),
        planHash: coverageSignature(entries),
    };

    return {
        today,
        window,
        memoryOn: memoryOn && ledger !== null,
        outputRoot,
        pending: resolved,
        state,
        plan,
        episodes,
        missingAudio,
        unheard,
        latestEpisode,
        oldestStoredDate,
        expiringDates: expiringPending(entries.map((e) => e.date), today, settings.newsletterRetentionDays ?? 30),
        skipped,
        noBriefDates: pending.noStoredDates.filter((d) => days.get(d)?.digestExists === true),
        evidenceDegraded,
        autoPendingDays,
        tidy,
    };
}
