import { describe, it, expect } from 'vitest';
import {
    shiftDate,
    windowDates,
    effectiveLookbackDays,
    mergeCoverage,
    mergeCoverageMaps,
    parseCoverageValue,
    parseCoverageMap,
    coverageToFrontmatter,
    parseEpisodeName,
    buildEpisodeName,
    parseEpisodeFrontmatter,
    deriveCoverage,
    unheardEpisodes,
    effectiveCapMinutes,
    lengthPlan,
    computePending,
    deriveCaughtUpState,
    hasProvableGap,
    coverageSignature,
} from '../src/services/newsletter/catchUp/catchUpCoverage';
import type { BucketInfo, Coverage, CoverageMap, EpisodeMeta } from '../src/services/newsletter/catchUp/catchUpTypes';

const rev = (n: number): Coverage => ({ kind: 'revision', rev: n });
const whole: Coverage = { kind: 'whole' };

function bucket(date: string, over: Partial<BucketInfo> = {}): BucketInfo {
    return { date, hasBrief: true, closed: true, revision: 3, parseFailed: false, legacy: null, ...over };
}
function buckets(...bs: BucketInfo[]): Record<string, BucketInfo> {
    return Object.fromEntries(bs.map((b) => [b.date, b]));
}
function episode(id: string, to: string, coverage: CoverageMap, over: Partial<EpisodeMeta> = {}): EpisodeMeta {
    return { id, from: to, to, coverage, audio: `catchup-${id}.mp3`, fingerprint: 'abcd1234', minutes: 14, sources: 3, notePath: `Catch-up/${id}.md`, ...over };
}

describe('dates and window', () => {
    it('shiftDate crosses month and year boundaries', () => {
        expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
        expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
        expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('a lookback of N is exactly N calendar dates, today included', () => {
        expect(windowDates('2026-10-23', 1)).toEqual(['2026-10-23']);
        expect(windowDates('2026-10-23', 3)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
        expect(windowDates('2026-10-23', 7)).toHaveLength(7);
        expect(windowDates('2026-10-23', 7)[0]).toBe('2026-10-17');
    });

    it('clamps the lookback to 1..14 and to the retention period', () => {
        expect(effectiveLookbackDays(7, 30)).toBe(7);
        expect(effectiveLookbackDays(99, 0)).toBe(14);
        expect(effectiveLookbackDays(0, 0)).toBe(1);
        expect(effectiveLookbackDays('x', 0)).toBe(7);
        expect(effectiveLookbackDays(14, 5)).toBe(5);
        expect(effectiveLookbackDays(7, 0)).toBe(7);    // 0 retention = keep forever
        expect(effectiveLookbackDays(3, 10)).toBe(3);
    });
});

describe('coverage values', () => {
    it('merge is order-independent: absent is identity, whole absorbs, revisions keep the max', () => {
        expect(mergeCoverage(undefined, undefined)).toBeUndefined();
        expect(mergeCoverage(undefined, rev(2))).toEqual(rev(2));
        expect(mergeCoverage(rev(2), undefined)).toEqual(rev(2));
        expect(mergeCoverage(rev(2), rev(5))).toEqual(rev(5));
        expect(mergeCoverage(rev(5), rev(2))).toEqual(rev(5));
        expect(mergeCoverage(whole, rev(9))).toEqual(whole);
        expect(mergeCoverage(rev(9), whole)).toEqual(whole);
        expect(mergeCoverage(whole, whole)).toEqual(whole);
    });

    it('mergeCoverageMaps gives the same result for every episode order', () => {
        const a: CoverageMap = { '2026-10-20': rev(1), '2026-10-21': whole };
        const b: CoverageMap = { '2026-10-20': rev(4), '2026-10-21': rev(7), '2026-10-22': rev(2) };
        expect(mergeCoverageMaps(a, b)).toEqual(mergeCoverageMaps(b, a));
        expect(mergeCoverageMaps(a, b)).toEqual({ '2026-10-20': rev(4), '2026-10-21': whole, '2026-10-22': rev(2) });
    });

    it('zero is never a valid revision', () => {
        expect(parseCoverageValue(0)).toBeNull();
        expect(parseCoverageValue('0')).toBeNull();
        expect(parseCoverageValue(-1)).toBeNull();
        expect(parseCoverageValue(1.5)).toBeNull();
        expect(parseCoverageValue(null)).toBeNull();
        expect(parseCoverageValue('soon')).toBeNull();
    });

    it('parses whole and positive integers (numeric strings too)', () => {
        expect(parseCoverageValue('whole')).toEqual(whole);
        expect(parseCoverageValue(3)).toEqual(rev(3));
        expect(parseCoverageValue('3')).toEqual(rev(3));
    });

    it('round-trips through the frontmatter encoding', () => {
        for (const c of [whole, rev(1), rev(12)]) expect(parseCoverageValue(coverageToFrontmatter(c))).toEqual(c);
    });

    it('drops invalid dates and values from a coverage map', () => {
        expect(parseCoverageMap({ '2026-10-20': 2, 'not-a-date': 3, '2026-10-21': 0, '2026-10-22': 'whole' }))
            .toEqual({ '2026-10-20': rev(2), '2026-10-22': whole });
        expect(parseCoverageMap(null)).toEqual({});
        expect(parseCoverageMap([1, 2])).toEqual({});
        expect(parseCoverageMap('x')).toEqual({});
    });
});

describe('episode names and frontmatter', () => {
    it('round-trips a range and a single day', () => {
        const range = buildEpisodeName('2026-10-17', '2026-10-23', '20261023-081502-a1b2');
        expect(range).toBe('Catch-up 2026-10-17 to 2026-10-23 20261023-081502-a1b2.md');
        expect(parseEpisodeName(range)).toEqual({ from: '2026-10-17', to: '2026-10-23', id: '20261023-081502-a1b2' });
        const single = buildEpisodeName('2026-10-23', '2026-10-23', 'x1');
        expect(single).toBe('Catch-up 2026-10-23 x1.md');
        expect(parseEpisodeName(single)).toEqual({ from: '2026-10-23', to: '2026-10-23', id: 'x1' });
    });

    it('rejects names that are not episodes', () => {
        expect(parseEpisodeName('Digest — 2026-10-23.md')).toBeNull();
        expect(parseEpisodeName('Catch-up notes.md')).toBeNull();
        expect(parseEpisodeName('Catch-up 2026-10-23 x1.txt')).toBeNull();
    });

    const fm = {
        aio_type: 'newsletter-catchup',
        catchup_id: 'abc',
        catchup_from: '2026-10-21',
        catchup_to: '2026-10-23',
        catchup_coverage: { '2026-10-21': 2, '2026-10-22': 'whole' },
        catchup_audio: 'catchup-abc-12345678.mp3',
        catchup_fingerprint: '12345678',
        catchup_minutes: 14,
        catchup_sources: 9,
    };

    it('parses a valid episode', () => {
        const e = parseEpisodeFrontmatter(fm, 'Catch-up/x.md')!;
        expect(e.id).toBe('abc');
        expect(e.coverage).toEqual({ '2026-10-21': rev(2), '2026-10-22': whole });
        expect(e.minutes).toBe(14);
    });

    it.each([
        ['wrong type', { ...fm, aio_type: 'other' }],
        ['no id', { ...fm, catchup_id: '' }],
        ['no audio', { ...fm, catchup_audio: undefined }],
        ['bad from', { ...fm, catchup_from: 'yesterday' }],
        ['empty coverage', { ...fm, catchup_coverage: {} }],
        ['all-invalid coverage', { ...fm, catchup_coverage: { '2026-10-21': 0 } }],
    ])('a malformed episode covers nothing: %s', (_name, bad) => {
        expect(parseEpisodeFrontmatter(bad as Record<string, unknown>, 'p')).toBeNull();
    });

    it('null / missing frontmatter is not an episode', () => {
        expect(parseEpisodeFrontmatter(null, 'p')).toBeNull();
        expect(parseEpisodeFrontmatter(undefined, 'p')).toBeNull();
    });

    it('deriveCoverage merges across episodes', () => {
        const cov = deriveCoverage([
            episode('a', '2026-10-21', { '2026-10-21': rev(2) }),
            episode('b', '2026-10-22', { '2026-10-21': rev(5), '2026-10-22': rev(1) }),
        ]);
        expect(cov).toEqual({ '2026-10-21': rev(5), '2026-10-22': rev(1) });
    });
});

describe('unheardEpisodes', () => {
    const eps = [
        episode('old', '2026-10-01', { '2026-10-01': rev(1) }),
        episode('heard', '2026-10-20', { '2026-10-20': rev(1) }),
        episode('new', '2026-10-22', { '2026-10-22': rev(1) }),
    ];
    it('is independent of the watermark and respects the window', () => {
        const out = unheardEpisodes(eps, { heard: { ackedAt: 1 } }, '2026-10-17');
        expect(out.map((e) => e.id)).toEqual(['new']);
    });
    it('everything in-window is unheard with no acks', () => {
        expect(unheardEpisodes(eps, {}, '2026-10-17').map((e) => e.id)).toEqual(['heard', 'new']);
    });
});

describe('episode length', () => {
    it('aims for 15 minutes below 4 pending days and 20 from 4 days up', () => {
        expect(effectiveCapMinutes(0, 20)).toBe(15);
        expect(effectiveCapMinutes(1, 20)).toBe(15);
        expect(effectiveCapMinutes(3, 20)).toBe(15);
        expect(effectiveCapMinutes(4, 20)).toBe(20);
        expect(effectiveCapMinutes(7, 20)).toBe(20);
        expect(effectiveCapMinutes(14, 20)).toBe(20);
    });

    it('the user ceiling always wins when lower, and is clamped to 5..20', () => {
        expect(effectiveCapMinutes(7, 10)).toBe(10);
        expect(effectiveCapMinutes(1, 10)).toBe(10);
        expect(effectiveCapMinutes(1, 18)).toBe(15);
        expect(effectiveCapMinutes(7, 2)).toBe(5);
        expect(effectiveCapMinutes(7, 99)).toBe(20);
        expect(effectiveCapMinutes(7, 'x')).toBe(20);
    });

    it('is never linear in the number of days', () => {
        expect(effectiveCapMinutes(14, 20)).toBeLessThanOrEqual(20);
    });

    it('derives the word budget from the cap', () => {
        expect(lengthPlan(2, 20)).toEqual({ capMinutes: 15, wordBudget: 1950 });
        expect(lengthPlan(5, 20)).toEqual({ capMinutes: 20, wordBudget: 2600 });
    });
});

describe('computePending', () => {
    const window3 = ['2026-10-21', '2026-10-22', '2026-10-23'];
    const run = (over: Partial<Parameters<typeof computePending>[0]> = {}) =>
        computePending({
            window: window3,
            buckets: buckets(bucket('2026-10-21'), bucket('2026-10-22'), bucket('2026-10-23', { closed: false })),
            coverage: {},
            memoryOn: true,
            kind: 'manual',
            ...over,
        });

    it('never-covered days are full entries carrying the current revision', () => {
        const r = run();
        expect(r.entries.map((e) => [e.date, e.kind, e.coverage])).toEqual([
            ['2026-10-21', 'full', rev(3)],
            ['2026-10-22', 'full', rev(3)],
            ['2026-10-23', 'full', rev(3)],
        ]);
    });

    it('days with no stored brief are reported neutrally', () => {
        const r = run({ buckets: buckets(bucket('2026-10-22'), bucket('2026-10-23', { hasBrief: false })) });
        expect(r.noStoredDates).toEqual(['2026-10-21', '2026-10-23']);
        expect(r.entries.map((e) => e.date)).toEqual(['2026-10-22']);
    });

    it('automatic runs skip the still-open bucket; manual runs include it', () => {
        const auto = run({ kind: 'auto' });
        expect(auto.entries.map((e) => e.date)).toEqual(['2026-10-21', '2026-10-22']);
        expect(auto.openDates).toEqual(['2026-10-23']);
        expect(run({ kind: 'manual' }).entries.map((e) => e.date)).toContain('2026-10-23');
    });

    it('with story memory off only CLOSED buckets are eligible, and they are written as whole', () => {
        const r = run({ memoryOn: false });
        expect(r.entries.map((e) => [e.date, e.coverage])).toEqual([
            ['2026-10-21', whole],
            ['2026-10-22', whole],
        ]);
        expect(r.openDates).toEqual(['2026-10-23']);
    });

    it('memory off: a never-covered day IS pending (no zero-revision trap)', () => {
        const r = run({ memoryOn: false, buckets: buckets(bucket('2026-10-22', { revision: null })), window: ['2026-10-22'] });
        expect(r.entries).toHaveLength(1);
        expect(r.entries[0].coverage).toEqual(whole);
    });

    it('a day covered whole is never pending again, however far the bucket moves', () => {
        const r = run({ coverage: { '2026-10-21': whole }, buckets: buckets(bucket('2026-10-21', { revision: 99 })), window: ['2026-10-21'] });
        expect(r.entries).toEqual([]);
        expect(r.coveredDates).toEqual(['2026-10-21']);
    });

    it('revision coverage equal to the current revision is covered', () => {
        const r = run({ coverage: { '2026-10-21': rev(3) }, window: ['2026-10-21'] });
        expect(r.entries).toEqual([]);
        expect(r.coveredDates).toEqual(['2026-10-21']);
    });

    it('a newer revision becomes a DELTA since the covered one', () => {
        const r = run({ coverage: { '2026-10-21': rev(2) }, window: ['2026-10-21'] });
        expect(r.entries).toEqual([{ date: '2026-10-21', kind: 'delta', coverage: rev(3), sinceRevision: 2 }]);
    });

    it('a delta that cannot be itemised is UNRESOLVED, not actionable and not re-told', () => {
        const r = run({
            coverage: { '2026-10-21': rev(2) },
            buckets: buckets(bucket('2026-10-21', { parseFailed: true })),
            window: ['2026-10-21'],
        });
        expect(r.entries).toEqual([]);
        expect(r.unresolved).toEqual([{ date: '2026-10-21', reason: 'unitemisable' }]);
    });

    it('current revision lower than covered (memory purged and restarted) is treated as whole', () => {
        const r = run({ coverage: { '2026-10-21': rev(5) }, buckets: buckets(bucket('2026-10-21', { revision: 2 })), window: ['2026-10-21'] });
        expect(r.entries).toEqual([]);
        expect(r.coveredDates).toEqual(['2026-10-21']);
    });

    it('revision coverage with an unknown current revision (aged out of the ledger) is treated as whole', () => {
        const r = run({ coverage: { '2026-10-21': rev(2) }, buckets: buckets(bucket('2026-10-21', { revision: null })), window: ['2026-10-21'] });
        expect(r.entries).toEqual([]);
    });

    it('memory off: revision coverage written earlier never produces a delta', () => {
        const r = run({ memoryOn: false, coverage: { '2026-10-21': rev(2) }, window: ['2026-10-21'] });
        expect(r.entries).toEqual([]);
    });

    describe('legacy daily audio provenance', () => {
        it('a stale legacy audio on an advanced bucket yields a delta', () => {
            const r = run({ buckets: buckets(bucket('2026-10-21', { revision: 5, legacy: rev(3) })), window: ['2026-10-21'] });
            expect(r.entries).toEqual([{ date: '2026-10-21', kind: 'delta', coverage: rev(5), sinceRevision: 3 }]);
        });
        it('legacy whole (provenance expired but the file exists) covers the day', () => {
            const r = run({ buckets: buckets(bucket('2026-10-21', { legacy: whole })), window: ['2026-10-21'] });
            expect(r.entries).toEqual([]);
        });
        it('episode coverage and legacy coverage merge', () => {
            const r = run({
                coverage: { '2026-10-21': rev(1) },
                buckets: buckets(bucket('2026-10-21', { revision: 4, legacy: rev(3) })),
                window: ['2026-10-21'],
            });
            expect(r.entries[0].sinceRevision).toBe(3);
        });
    });

    it('window dates that are open with memory on are included when manual', () => {
        const r = run({ kind: 'manual' });
        expect(r.openDates).toEqual([]);
    });
});

describe('deriveCaughtUpState', () => {
    const empty = { entries: [], unresolved: [], noStoredDates: [], coveredDates: [], openDates: [] };

    it('pending when anything is actionable', () => {
        const pending = { ...empty, entries: [{ date: '2026-10-21', kind: 'full' as const, coverage: rev(1) }] };
        expect(deriveCaughtUpState({ pending, latestEpisodeTo: null, oldestStoredDate: '2026-10-21' })).toBe('pending');
    });

    it('unresolved updates never read as caught up', () => {
        const pending = { ...empty, unresolved: [{ date: '2026-10-21', reason: 'unitemisable' as const }] };
        expect(deriveCaughtUpState({ pending, latestEpisodeTo: '2026-10-20', oldestStoredDate: '2026-10-21' })).toBe('unresolved-only');
    });

    it('caught up needs both lists empty and no provable gap', () => {
        expect(deriveCaughtUpState({ pending: empty, latestEpisodeTo: '2026-10-22', oldestStoredDate: '2026-10-23' })).toBe('caught-up');
        expect(deriveCaughtUpState({ pending: empty, latestEpisodeTo: null, oldestStoredDate: '2026-10-23' })).toBe('caught-up');
    });

    it('a gap is provable only from the episode record', () => {
        expect(hasProvableGap('2026-10-10', '2026-10-17')).toBe(true);
        expect(hasProvableGap('2026-10-16', '2026-10-17')).toBe(false);
        expect(hasProvableGap('2026-10-17', '2026-10-17')).toBe(false);
        expect(hasProvableGap(null, '2026-10-17')).toBe(false);
        expect(hasProvableGap('2026-10-10', null)).toBe(false);
        expect(deriveCaughtUpState({ pending: empty, latestEpisodeTo: '2026-10-10', oldestStoredDate: '2026-10-17' })).toBe('gap');
    });
});

describe('coverageSignature', () => {
    const a = { date: '2026-10-21', kind: 'full' as const, coverage: rev(3) };
    const b = { date: '2026-10-22', kind: 'delta' as const, coverage: rev(4), sinceRevision: 2 };
    it('is order-independent and deterministic', () => {
        expect(coverageSignature([a, b])).toBe(coverageSignature([b, a]));
        expect(coverageSignature([a, b])).toMatch(/^[0-9a-f]{8}$/);
    });
    it('changes when coverage changes', () => {
        expect(coverageSignature([a])).not.toBe(coverageSignature([{ ...a, coverage: rev(4) }]));
        expect(coverageSignature([a])).not.toBe(coverageSignature([{ ...a, coverage: whole }]));
        expect(coverageSignature([a])).not.toBe(coverageSignature([]));
    });
});
