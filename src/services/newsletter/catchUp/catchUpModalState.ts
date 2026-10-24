/**
 * Catch-up window — what to show, decided purely.
 *
 * Takes the facts (a read-only snapshot, the stored operation, mode availability) and returns
 * ONE view. No DOM, no Obsidian: every state of the window is a unit test, and the modal is a
 * thin renderer over this.
 */

import type { CatchUpSnapshot } from './catchUpSelection';
import type { OperationState } from './catchUpService';
import { getAudioMode, type AudioModeSettings } from '../newsletterAudioMode';
import { CATCHUP_BIG_THRESHOLD_DAYS, type EpisodeMeta, type SkippedDay, type TidyPlan } from './catchUpTypes';

export type Availability = 'ok' | 'audio-off' | 'wrong-mode';

/** Whether the window can generate at all: audio must be on, and not in the daily mode. */
export function availabilityOf(settings: AudioModeSettings): Availability {
    if (settings.newsletterAudioPodcast !== true) return 'audio-off';
    return getAudioMode(settings) === 'daily' ? 'wrong-mode' : 'ok';
}

/**
 * Smart daily is silently waiting: an earlier episode is unheard, so the automatic run makes nothing
 * even though days are pending. Said plainly in the window and the status bar. Null in every other situation,
 * including when nothing would run anyway (no day an automatic run would cover), so the message is always true.
 */
export interface Waiting {
    /** Days an automatic run would cover once the wait ends. */
    days: number;
    /** Every episode holding the run back, newest first. */
    episodes: EpisodeMeta[];
}

export type StateSettings = AudioModeSettings & { newsletterCatchUpWhenBehind?: unknown };

export function deriveWaiting(
    snapshot: Pick<CatchUpSnapshot, 'unheard' | 'autoPendingDays'>,
    settings: StateSettings,
): Waiting | null {
    if (settings.newsletterAudioPodcast !== true || getAudioMode(settings) !== 'smart-daily') return null;
    // Automatic replacement does not wait (its own wording covers it).
    if (settings.newsletterCatchUpWhenBehind === 'replace') return null;
    if (snapshot.unheard.length === 0 || snapshot.autoPendingDays < 1) return null;
    return {
        days: snapshot.autoPendingDays,
        episodes: [...snapshot.unheard].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    };
}

/** Automatic replacement is on and will act at the next fetch: say so instead of claiming to wait. */
export function deriveReplaceSoon(
    snapshot: Pick<CatchUpSnapshot, 'unheard' | 'autoPendingDays'>,
    settings: StateSettings,
): boolean {
    return settings.newsletterAudioPodcast === true
        && getAudioMode(settings) === 'smart-daily'
        && settings.newsletterCatchUpWhenBehind === 'replace'
        && snapshot.unheard.length > 0
        && snapshot.autoPendingDays >= 1;
}

export interface UnheardInfo {
    episode: EpisodeMeta;
    /** Every in-window unheard episode, newest first. */
    count: number;
}

interface Common {
    unheard: UnheardInfo | null;
    /** Smart daily is waiting for the unheard episode(s); see `deriveWaiting`. */
    waiting: Waiting | null;
    /** Automatic replacement will replace the unheard episode at the next fetch (see `deriveReplaceSoon`). */
    replaceSoon: boolean;
    latestEpisode: EpisodeMeta | null;
    noStoredDates: string[];
    expiringDates: string[];
    /** Window days left out of the plan on purpose (heard daily audio, still-open day), so the window can say so. */
    skipped: SkippedDay[];
    /** Every window day that has a stored brief: what "include all again" re-lists. */
    windowDates: string[];
    /** The listening history could not be read: daily audio you may have heard is offered again. */
    evidenceDegraded: boolean;
}

export type ModalView =
    | { kind: 'unavailable'; reason: 'audio-off' | 'wrong-mode' }
    | (Common & {
        kind: 'resume';
        phase: 'scripted' | 'audio-writing' | 'audio-ready';
        /** Finish saving only writes the note; Resume makes (more) audio first. */
        action: 'resume' | 'finish-saving';
        from: string;
        to: string;
        days: number;
    })
    | (Common & {
        kind: 'pending';
        from: string;
        to: string;
        /** The plan's actual dates: `from`/`to` alone would imply the skipped days between them are included. */
        dates: string[];
        days: number;
        newsletters: number;
        capMinutes: number;
        big: boolean;
        planHash: string;
        unresolvedDates: string[];
        /** Superseded daily audio the episode would let the person remove, or null. */
        tidy: TidyPlan | null;
    })
    | (Common & { kind: 'caught-up'; through: string })
    | (Common & { kind: 'gap'; lastEpisodeTo: string })
    | (Common & { kind: 'unresolved-only'; unresolvedDates: string[] });

export interface ModalInput {
    availability: Availability;
    snapshot: CatchUpSnapshot;
    operation: OperationState;
    /** The mode settings, for the waiting state. Absent means "never waiting". */
    settings?: StateSettings;
}

export function deriveModalView(input: ModalInput): ModalView {
    if (input.availability !== 'ok') return { kind: 'unavailable', reason: input.availability };

    const { snapshot, operation } = input;
    const common: Common = {
        unheard: snapshot.unheard.length > 0
            ? { episode: [...snapshot.unheard].sort((a, b) => (a.id < b.id ? 1 : -1))[0], count: snapshot.unheard.length }
            : null,
        waiting: input.settings ? deriveWaiting(snapshot, input.settings) : null,
        replaceSoon: input.settings ? deriveReplaceSoon(snapshot, input.settings) : false,
        latestEpisode: snapshot.latestEpisode,
        noStoredDates: snapshot.pending.noStoredDates,
        expiringDates: snapshot.expiringDates,
        skipped: snapshot.skipped,
        // What "include all again" can actually re-list: days with a stored brief, minus still-open days (never offered while memory is off).
        windowDates: snapshot.window.filter((d) => !snapshot.pending.noStoredDates.includes(d) && !snapshot.skipped.some((s) => s.date === d && s.reason === 'open-day')),
        evidenceDegraded: snapshot.evidenceDegraded,
    };

    // An unfinished operation takes the window until the person resolves it: starting a second
    // one would silently replace the first.
    if (operation.kind === 'scripted' || operation.kind === 'audio-writing' || operation.kind === 'audio-ready') {
        const f = operation.record.frozen;
        return {
            ...common,
            kind: 'resume',
            phase: operation.kind,
            action: operation.kind === 'audio-ready' ? 'finish-saving' : 'resume',
            from: f.from,
            to: f.to,
            days: f.entries.length,
        };
    }

    const unresolvedDates = snapshot.pending.unresolved.map((u) => u.date);
    const plan = snapshot.plan;
    if (plan) {
        return {
            ...common,
            kind: 'pending',
            from: plan.from,
            to: plan.to,
            dates: plan.entries.map((e) => e.date),
            days: plan.entries.length,
            newsletters: plan.entries.reduce((n, e) => n + e.newsletters, 0),
            capMinutes: plan.length.capMinutes,
            big: plan.entries.length >= CATCHUP_BIG_THRESHOLD_DAYS,
            planHash: plan.planHash,
            unresolvedDates,
            tidy: snapshot.tidy,
        };
    }

    switch (snapshot.state) {
        case 'unresolved-only':
            return { ...common, kind: 'unresolved-only', unresolvedDates };
        case 'gap':
            return { ...common, kind: 'gap', lastEpisodeTo: snapshot.latestEpisode?.to ?? snapshot.today };
        default:
            return { ...common, kind: 'caught-up', through: snapshot.today };
    }
}

/** The pending summary the status bar and the window header share. */
export function pendingCounts(snapshot: Pick<CatchUpSnapshot, 'plan'>): { days: number; newsletters: number } {
    const plan = snapshot.plan;
    return {
        days: plan?.entries.length ?? 0,
        newsletters: plan?.entries.reduce((n, e) => n + e.newsletters, 0) ?? 0,
    };
}
