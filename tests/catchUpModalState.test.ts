import { describe, it, expect } from 'vitest';
import { deriveModalView, pendingCounts, tidyForDays, type ModalInput } from '../src/services/newsletter/catchUp/catchUpModalState';
import type { CatchUpPlan, CatchUpPlanEntry, EpisodeMeta } from '../src/services/newsletter/catchUp/catchUpTypes';
import type { CatchUpSnapshot } from '../src/services/newsletter/catchUp/catchUpSelection';
import type { OperationRecord } from '../src/services/newsletter/catchUp/catchUpDraft';

const ep = (id: string, to: string): EpisodeMeta => ({
    id, from: to, to, coverage: { [to]: { kind: 'whole' } }, audio: `catchup-${id}.mp3`, fingerprint: 'ab', minutes: 10, sources: 3, notePath: `Catch-up/${id}.md`,
});

const entry = (date: string, newsletters = 2): CatchUpPlanEntry => ({
    date, kind: 'full', coverage: { kind: 'revision', rev: 1 }, text: 'text', newsletters, titles: [],
});

function plan(dates: string[]): CatchUpPlan {
    const entries = dates.map((d) => entry(d));
    return {
        entries, unresolved: [], noStoredDates: [], windowDates: dates,
        length: { capMinutes: dates.length >= 4 ? 20 : 15, wordBudget: 1950 },
        from: dates[0], to: dates[dates.length - 1], createdAt: 1, planHash: 'abcd1234',
    };
}

function snapshot(over: Partial<CatchUpSnapshot> = {}): CatchUpSnapshot {
    return {
        today: '2026-10-23', window: [], memoryOn: true, outputRoot: 'R',
        pending: { entries: [], unresolved: [], noStoredDates: [], coveredDates: [], openDates: [] },
        state: 'caught-up', plan: null, episodes: [], missingAudio: [], unheard: [], latestEpisode: null,
        oldestStoredDate: null, expiringDates: [], skipped: [], noBriefDates: [], evidenceDegraded: false, autoPendingDays: 0, tidy: null, ...over,
    };
}

const record = (phase: OperationRecord['phase']): OperationRecord => ({
    version: 1, opId: 'op', phase, script: 's', scriptIdentity: 'i', outputRoot: 'R', capMinutes: 15, createdAt: 1,
    frozen: { entries: [{ date: '2026-10-21', kind: 'full', coverage: { kind: 'whole' } }, { date: '2026-10-22', kind: 'full', coverage: { kind: 'whole' } }], from: '2026-10-21', to: '2026-10-22', sources: 4, titles: [] },
});

const input = (over: Partial<ModalInput> = {}): ModalInput => ({
    availability: 'ok', snapshot: snapshot(), operation: { kind: 'none' }, ...over,
});

describe('deriveModalView', () => {
    it('carries the skipped days and the plan dates through, so the window cannot imply a range', () => {
        const v = deriveModalView(input({ snapshot: snapshot({
            window: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'], plan: plan(['2026-10-20', '2026-10-23']), state: 'pending',
            skipped: [{ date: '2026-10-22', reason: 'heard-daily-audio' }],
            pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-21'], coveredDates: [], openDates: [] },
        }) }));
        expect(v).toMatchObject({ kind: 'pending', dates: ['2026-10-20', '2026-10-23'], skipped: [{ date: '2026-10-22', reason: 'heard-daily-audio' }], windowDates: ['2026-10-20', '2026-10-22', '2026-10-23'] });
    });

    it('unavailable states win over everything else', () => {
        expect(deriveModalView(input({ availability: 'audio-off', snapshot: snapshot({ plan: plan(['2026-10-22']) }) }))).toEqual({ kind: 'unavailable', reason: 'audio-off' });
        expect(deriveModalView(input({ availability: 'wrong-mode' }))).toEqual({ kind: 'unavailable', reason: 'wrong-mode' });
    });

    it('pending: counts days and newsletters and reports the cap', () => {
        const v = deriveModalView(input({ snapshot: snapshot({ plan: plan(['2026-10-21', '2026-10-22', '2026-10-23']), state: 'pending' }) }));
        expect(v).toMatchObject({ kind: 'pending', from: '2026-10-21', to: '2026-10-23', days: 3, newsletters: 6, capMinutes: 15, big: false, planHash: 'abcd1234' });
    });

    it('four or more pending days are "big" (the 20 minute tier)', () => {
        const v = deriveModalView(input({ snapshot: snapshot({ plan: plan(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) }) }));
        expect(v).toMatchObject({ kind: 'pending', days: 4, capMinutes: 20, big: true });
    });

    it('waiting is derived from the settings and carries every blocking episode, newest first', () => {
        const s = snapshot({ plan: plan(['2026-10-23']), state: 'pending', unheard: [ep('20261020-100000-aaaa', '2026-10-19'), ep('20261021-100000-bbbb', '2026-10-20')], autoPendingDays: 2 });
        const smart = { newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' };
        const v = deriveModalView(input({ snapshot: s, settings: smart }));
        expect(v).toMatchObject({ kind: 'pending', waiting: { days: 2 } });
        expect((v as { waiting: { episodes: Array<{ id: string }> } }).waiting.episodes.map((e) => e.id)).toEqual(['20261021-100000-bbbb', '20261020-100000-aaaa']);
        expect(deriveModalView(input({ snapshot: s }))).toMatchObject({ waiting: null });
    });

    it('says automatic replacement will act (not that it waits) when that setting is on', () => {
        const s = snapshot({ plan: plan(['2026-10-23']), state: 'pending', unheard: [ep('20261020-100000-aaaa', '2026-10-19')], autoPendingDays: 1 });
        const smart = { newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' };
        expect(deriveModalView(input({ snapshot: s, settings: { ...smart, newsletterCatchUpWhenBehind: 'replace' } }))).toMatchObject({ waiting: null, replaceSoon: true });
        expect(deriveModalView(input({ snapshot: s, settings: { ...smart, newsletterCatchUpWhenBehind: 'wait' } }))).toMatchObject({ waiting: { days: 1 }, replaceSoon: false });
        expect(deriveModalView(input({ snapshot: snapshot({ ...s, autoPendingDays: 0 }), settings: { ...smart, newsletterCatchUpWhenBehind: 'replace' } }))).toMatchObject({ replaceSoon: false });
        expect(deriveModalView(input({ snapshot: s, settings: { newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand', newsletterCatchUpWhenBehind: 'replace' } }))).toMatchObject({ replaceSoon: false });
    });

    it('include-all never offers a still-open day (it would stay left out)', () => {
        const v = deriveModalView(input({ snapshot: snapshot({
            window: ['2026-10-22', '2026-10-23'], state: 'caught-up',
            skipped: [{ date: '2026-10-23', reason: 'open-day' }],
        }) }));
        expect(v).toMatchObject({ kind: 'caught-up', windowDates: ['2026-10-22'] });
    });

    it('an unfinished operation takes the window, whatever else is pending', () => {
        const v = deriveModalView(input({
            snapshot: snapshot({ plan: plan(['2026-10-23']) }),
            operation: { kind: 'scripted', record: record('scripted') },
        }));
        expect(v).toMatchObject({ kind: 'resume', phase: 'scripted', action: 'resume', from: '2026-10-21', to: '2026-10-22', days: 2 });
    });

    it('verified audio offers Finish saving; interrupted audio offers Resume', () => {
        expect(deriveModalView(input({ operation: { kind: 'audio-ready', record: record('audio-ready') } }))).toMatchObject({ kind: 'resume', action: 'finish-saving' });
        expect(deriveModalView(input({ operation: { kind: 'audio-writing', record: record('audio-writing') } }))).toMatchObject({ kind: 'resume', action: 'resume' });
    });

    it('a committed or expired record is not an unfinished operation', () => {
        expect(deriveModalView(input({ operation: { kind: 'committed', opId: 'op' } })).kind).toBe('caught-up');
        expect(deriveModalView(input({ operation: { kind: 'expired', record: record('scripted') } })).kind).toBe('caught-up');
    });

    it('nothing pending: caught up, gap and unresolved-only stay distinct', () => {
        expect(deriveModalView(input({ snapshot: snapshot({ state: 'caught-up' }) }))).toMatchObject({ kind: 'caught-up', through: '2026-10-23' });
        expect(deriveModalView(input({ snapshot: snapshot({ state: 'gap', latestEpisode: ep('a', '2026-10-10') }) }))).toMatchObject({ kind: 'gap', lastEpisodeTo: '2026-10-10' });
        const unresolved = snapshot({
            state: 'unresolved-only',
            pending: { entries: [], unresolved: [{ date: '2026-10-22', reason: 'unitemisable' }], noStoredDates: [], coveredDates: [], openDates: [] },
        });
        expect(deriveModalView(input({ snapshot: unresolved }))).toMatchObject({ kind: 'unresolved-only', unresolvedDates: ['2026-10-22'] });
    });

    it('surfaces the newest unheard episode and the count', () => {
        const v = deriveModalView(input({ snapshot: snapshot({ unheard: [ep('20261020-000000-aaaa', '2026-10-20'), ep('20261022-000000-bbbb', '2026-10-22')] }) }));
        expect(v).toMatchObject({ kind: 'caught-up', unheard: { count: 2, episode: { id: '20261022-000000-bbbb' } } });
    });

    it('carries the neutral no-stored and expiring dates on every state', () => {
        const s = snapshot({
            plan: plan(['2026-10-22']), expiringDates: ['2026-10-22'],
            pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-20'], coveredDates: [], openDates: [] },
        });
        expect(deriveModalView(input({ snapshot: s }))).toMatchObject({ noStoredDates: ['2026-10-20'], expiringDates: ['2026-10-22'] });
    });

    it('lists unresolved dates on a pending view too (never silently dropped)', () => {
        const s = snapshot({
            plan: plan(['2026-10-22']),
            pending: { entries: [], unresolved: [{ date: '2026-10-21', reason: 'unitemisable' }], noStoredDates: [], coveredDates: [], openDates: [] },
        });
        expect(deriveModalView(input({ snapshot: s }))).toMatchObject({ kind: 'pending', unresolvedDates: ['2026-10-21'] });
    });
});

const tidyFile = (date: string, bytes = 1000) => ({
    date, name: `brief-${date}-abcd1234.mp3`, path: `R/${date}/brief-${date}-abcd1234.mp3`, bytes, mtime: 1, narratedRev: null, digestPath: `R/Digest ${date}.md`, briefHash: 'aa',
});

// Persona A2: Resume dropped the tidy choice the person had ticked before the failed run.
describe('the unfinished episode keeps its tidy', () => {
    const tidy = { files: [tidyFile('2026-10-21'), tidyFile('2026-10-22', 500), tidyFile('2026-10-23')], bytes: 2500, days: ['2026-10-21', '2026-10-22', '2026-10-23'] };
    const dates = (v: unknown) => (v as { tidy: { files: Array<{ date: string }> } }).tidy.files.map((x) => x.date);

    it('is the part of the daily audio that belongs to the episode\'s own days', () => {
        const v = deriveModalView(input({ snapshot: snapshot({ tidy }), operation: { kind: 'scripted', record: record('scripted') } }));
        expect(v).toMatchObject({ kind: 'resume', tidy: { bytes: 1500, days: ['2026-10-21', '2026-10-22'] } });
        expect(dates(v)).toEqual(['2026-10-21', '2026-10-22']);
    });

    it('is null when no daily audio belongs to those days, or there is none', () => {
        expect(deriveModalView(input({ snapshot: snapshot({ tidy: null }), operation: { kind: 'audio-ready', record: record('audio-ready') } }))).toMatchObject({ kind: 'resume', tidy: null });
        expect(tidyForDays(tidy, ['2026-10-30'])).toBeNull();
    });

    it('only a day the episode covers in FULL can ever be tidied, never a delta day', () => {
        const rec = record('scripted');
        rec.frozen.entries[1] = { date: '2026-10-22', kind: 'delta', coverage: { kind: 'whole' }, sinceRevision: 1 } as never;
        const v = deriveModalView(input({ snapshot: snapshot({ tidy }), operation: { kind: 'scripted', record: rec } }));
        expect(dates(v)).toEqual(['2026-10-21']);
    });
});

describe('pendingCounts', () => {
    it('zero without a plan', () => {
        expect(pendingCounts({ plan: null })).toEqual({ days: 0, newsletters: 0 });
    });
    it('sums the plan', () => {
        expect(pendingCounts({ plan: plan(['2026-10-21', '2026-10-22']) })).toEqual({ days: 2, newsletters: 4 });
    });
});

describe('the status bar and the window agree on what is pending', () => {
    const pendingInput = (dates: string[], unheard: EpisodeMeta[] = []) =>
        input({ snapshot: snapshot({ plan: plan(dates), state: 'pending', unheard }) });

    it('the window\'s day and newsletter totals equal the shared selector the status bar uses', () => {
        for (const dates of [['2026-10-23'], ['2026-10-22', '2026-10-23'], ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']]) {
            const inp = pendingInput(dates);
            const view = deriveModalView(inp);
            const counts = pendingCounts(inp.snapshot);
            expect(view).toMatchObject({ kind: 'pending', days: counts.days, newsletters: counts.newsletters });
        }
    });

    it('with nothing pending both surfaces report zero, and the unheard count is the only signal', () => {
        const inp = input({ snapshot: snapshot({ unheard: [ep('e1', '2026-10-20')] }) });
        expect(pendingCounts(inp.snapshot)).toEqual({ days: 0, newsletters: 0 });
        expect(deriveModalView(inp)).toMatchObject({ kind: 'caught-up', unheard: { count: 1 } });
    });

    it('days with no stored newsletters are not counted as pending by either surface', () => {
        const s = snapshot({
            plan: plan(['2026-10-22']), state: 'pending',
            pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-20', '2026-10-21'], coveredDates: [], openDates: [] },
        });
        expect(pendingCounts(s).days).toBe(1);
        expect(deriveModalView(input({ snapshot: s }))).toMatchObject({ days: 1, noStoredDates: ['2026-10-20', '2026-10-21'] });
    });
});

describe('days left out for want of a brief', () => {
    it('splits the not-stored days from the stored-but-no-brief days', () => {
        const v = deriveModalView(input({ snapshot: snapshot({
            window: ['2026-10-19', '2026-10-20', '2026-10-21'], plan: plan(['2026-10-21']), state: 'pending',
            pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-19', '2026-10-20'], coveredDates: [], openDates: [] },
            noBriefDates: ['2026-10-20'],
        }) }));
        expect(v).toMatchObject({ noStoredDates: ['2026-10-19'], noBriefDates: ['2026-10-20'] });
    });

    it('a snapshot without the split (an older caller) keeps every day under "not stored"', () => {
        const s = snapshot({ pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-19'], coveredDates: [], openDates: [] } });
        delete (s as { noBriefDates?: unknown }).noBriefDates;
        expect(deriveModalView(input({ snapshot: s }))).toMatchObject({ noStoredDates: ['2026-10-19'], noBriefDates: [] });
    });
});
