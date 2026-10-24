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
    expiringPending,
    legacyHeard,
    lengthPlan,
    unheardEpisodes,
    windowDates,
} from './catchUpCoverage';
import { findLatestEpisode, findLatestNarratedEpisode, loadEpisodes } from './catchUpEpisode';
import { loadAcks } from './catchUpDraft';
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
    /**
     * The listening record could not be read, so no daily audio counted as heard. The window says so
     * and the automatic run holds back: a person may choose to generate anyway, an unattended run may not.
     */
    evidenceDegraded: boolean;
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
    brief: string;
    newsletters: number;
}

async function readDay(
    app: App,
    outputRoot: string,
    date: string,
    ledger: StoryLedger | null,
    consumption: ConsumptionState | null,
    closed: boolean,
): Promise<DayFacts> {
    const digest = app.vault.getAbstractFileByPath(getDigestPath(outputRoot, date));
    let brief = '';
    let newsletters = 0;
    if (digest instanceof TFile) {
        try {
            const content = await app.vault.cachedRead(digest);
            brief = extractBriefFromDigest(content);
            newsletters = countDigestSources(content, date);
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
    return { info, brief, newsletters };
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
    const coverage = deriveCoverage(episodes);
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

    const oldestStoredDate = window.find((d) => days.get(d)?.info.hasBrief) ?? null;

    // A delta whose late additions cannot be itemised into text is unresolved, never silently dropped.
    const entries: CatchUpPlanEntry[] = [];
    const unresolved = [...pending.unresolved];
    for (const e of pending.entries) {
        const facts = days.get(e.date) as DayFacts;
        const body = e.kind === 'delta'
            ? deltaText(ledger, e.date, e.sinceRevision ?? 0)
            : { text: facts.brief, titles: titlesFromBrief(facts.brief) };
        if (body.text.trim() === '') { unresolved.push({ date: e.date, reason: 'unitemisable' }); continue; }
        entries.push({ ...e, text: body.text, newsletters: facts.newsletters, titles: body.titles });
    }
    const resolved: PendingResult = { ...pending, entries, unresolved };

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
        evidenceDegraded,
    };
}
