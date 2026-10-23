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
import { CATCHUP_BIG_THRESHOLD_DAYS, type EpisodeMeta } from './catchUpTypes';

export type Availability = 'ok' | 'audio-off' | 'wrong-mode';

/** Whether the window can generate at all: audio must be on, and not in the daily mode. */
export function availabilityOf(settings: AudioModeSettings): Availability {
    if (settings.newsletterAudioPodcast !== true) return 'audio-off';
    return getAudioMode(settings) === 'daily' ? 'wrong-mode' : 'ok';
}

export interface UnheardInfo {
    episode: EpisodeMeta;
    /** Every in-window unheard episode, newest first. */
    count: number;
}

interface Common {
    unheard: UnheardInfo | null;
    latestEpisode: EpisodeMeta | null;
    noStoredDates: string[];
    expiringDates: string[];
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
        days: number;
        newsletters: number;
        capMinutes: number;
        big: boolean;
        planHash: string;
        unresolvedDates: string[];
    })
    | (Common & { kind: 'caught-up'; through: string })
    | (Common & { kind: 'gap'; lastEpisodeTo: string })
    | (Common & { kind: 'unresolved-only'; unresolvedDates: string[] });

export interface ModalInput {
    availability: Availability;
    snapshot: CatchUpSnapshot;
    operation: OperationState;
}

export function deriveModalView(input: ModalInput): ModalView {
    if (input.availability !== 'ok') return { kind: 'unavailable', reason: input.availability };

    const { snapshot, operation } = input;
    const common: Common = {
        unheard: snapshot.unheard.length > 0
            ? { episode: [...snapshot.unheard].sort((a, b) => (a.id < b.id ? 1 : -1))[0], count: snapshot.unheard.length }
            : null,
        latestEpisode: snapshot.latestEpisode,
        noStoredDates: snapshot.pending.noStoredDates,
        expiringDates: snapshot.expiringDates,
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
            days: plan.entries.length,
            newsletters: plan.entries.reduce((n, e) => n + e.newsletters, 0),
            capMinutes: plan.length.capMinutes,
            big: plan.entries.length >= CATCHUP_BIG_THRESHOLD_DAYS,
            planHash: plan.planHash,
            unresolvedDates,
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
