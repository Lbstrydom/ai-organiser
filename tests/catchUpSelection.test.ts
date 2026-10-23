import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { DEFAULT_SETTINGS } from '../src/core/settings';
import {
    buildCatchUpSnapshot,
    legacyCoverageFor,
    titlesFromBrief,
    countDigestSources,
} from '../src/services/newsletter/catchUp/catchUpSelection';
import { buildEpisodeNote, type EpisodeNoteInput } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const TODAY = '2026-10-23';

const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n- **Story ${n} beta**: Synthetic summary beta for fixture ${n}. (Sources: Fixture B)\n`;

function digest(date: string, text: string, sources = 2): string {
    const links = Array.from({ length: sources }, (_, i) => `- [[${date}/Fixture ${i + 1}|Fixture ${i + 1}]]`).join('\n');
    return `# Newsletter Digest — ${date}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${text}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n${links}\n`;
}

function ledgerBucket(revision: number, stories: Array<[string, number, number]>, extra: Record<string, unknown> = {}) {
    return {
        revision,
        updatedAt: 1,
        stories: stories.map(([title, first, content]) => ({
            key: title.toLowerCase().replaceAll(' ', ' '),
            title,
            gist: `Gist for ${title}`,
            firstRevision: first,
            contentRevision: content,
        })),
        audio: {} as Record<string, number>,
        ...extra,
    };
}

function makePlugin(data: Record<string, unknown> = {}) {
    return {
        loadData: async () => structuredClone(data),
        saveData: vi.fn(),
    };
}

function settings(over: Record<string, unknown> = {}) {
    return {
        ...DEFAULT_SETTINGS,
        featureFlags: { newsletter: true },
        newsletterAudioPodcast: true,
        newsletterStoryMemory: true,
        newsletterCatchUpLookbackDays: 7,
        newsletterRetentionDays: 30,
        ...over,
    } as never;
}

function episodeInput(over: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
    return {
        id: '20261022-081500-a1b2',
        from: '2026-10-20',
        to: '2026-10-21',
        coverage: { '2026-10-20': { kind: 'revision', rev: 2 }, '2026-10-21': { kind: 'revision', rev: 2 } },
        audio: 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3',
        fingerprint: 'c3d4e5f6',
        minutes: 12,
        sources: 4,
        titles: ['Story 20 alpha'],
        script: 'script',
        ...over,
    };
}

function addEpisode(vault: ReturnType<typeof makeCatchUpVault>, i: EpisodeNoteInput, audio = true): void {
    vault.set(`${FOLDER}/${buildEpisodeName(i.from, i.to, i.id)}`, buildEpisodeNote(i));
    if (audio) vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4));
}

let vault: ReturnType<typeof makeCatchUpVault>;
const NOW = new Date(2026, 9, 23, 12, 0, 0);

function baseVault(): ReturnType<typeof makeCatchUpVault> {
    const v = makeCatchUpVault();
    for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) v.set(`${ROOT}/Digest — ${d}.md`, digest(d, brief(d.slice(-2))));
    return v;
}

function baseLedger(extra: Record<string, ReturnType<typeof ledgerBucket>> = {}) {
    return {
        'newsletter-story-ledger': {
            version: 1,
            buckets: {
                '2026-10-20': ledgerBucket(2, [['Story 20 alpha', 1, 1], ['Story 20 beta', 1, 2]]),
                '2026-10-21': ledgerBucket(2, [['Story 21 alpha', 1, 1]]),
                '2026-10-22': ledgerBucket(3, [['Story 22 alpha', 1, 1], ['Story 22 beta', 3, 3]]),
                '2026-10-23': ledgerBucket(1, [['Story 23 alpha', 1, 1]]),
                ...extra,
            },
        },
    };
}

const snap = (opts: { data?: Record<string, unknown>; s?: Record<string, unknown>; kind?: 'manual' | 'auto' } = {}) =>
    buildCatchUpSnapshot({ app: vault.app as never, plugin: makePlugin(opts.data ?? baseLedger()) as never, settings: settings(opts.s), now: NOW }, opts.kind ?? 'manual');

beforeEach(() => { vault = baseVault(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('helpers', () => {
    it('titlesFromBrief reads bullet titles', () => {
        expect(titlesFromBrief(brief('7'))).toEqual(['Story 7 alpha', 'Story 7 beta']);
        expect(titlesFromBrief('plain text')).toEqual([]);
    });

    it('countDigestSources counts distinct linked notes for the day', () => {
        expect(countDigestSources(digest('2026-10-20', 'x', 3), '2026-10-20')).toBe(3);
        expect(countDigestSources('[[2026-10-21/A]] [[2026-10-21/A]]', '2026-10-21')).toBe(1);
        expect(countDigestSources('nothing', '2026-10-21')).toBe(0);
    });

    describe('legacyCoverageFor (provenance, never the embed text)', () => {
        const d = '2026-10-21';
        it('no audio file => no coverage', () => {
            expect(legacyCoverageFor(d, [], { 'brief-2026-10-21-abcd1234.mp3': 3 })).toBeNull();
            expect(legacyCoverageFor(d, ['notes.md'], undefined)).toBeNull();
        });
        it('a file with a recorded revision => that revision (max across files)', () => {
            expect(legacyCoverageFor(d, ['brief-2026-10-21-abcd1234.mp3', 'brief-2026-10-21-ffff0000.wav'], {
                'brief-2026-10-21-abcd1234.mp3': 2, 'brief-2026-10-21-ffff0000.wav': 4,
            })).toEqual({ kind: 'revision', rev: 4 });
        });
        it('a file with no surviving provenance => whole', () => {
            expect(legacyCoverageFor(d, ['brief-2026-10-21-abcd1234.mp3'], undefined)).toEqual({ kind: 'whole' });
            expect(legacyCoverageFor(d, ['brief-2026-10-21-abcd1234.mp3'], { other: 2 })).toEqual({ kind: 'whole' });
        });
        it('ignores files for other dates and malformed names', () => {
            expect(legacyCoverageFor(d, ['brief-2026-10-20-abcd1234.mp3', 'brief-2026-10-21-xyz.mp3'], {})).toBeNull();
        });
        it('mixed provenance: one mapped, one unmapped recording => whole (never re-tell)', () => {
            expect(legacyCoverageFor(d, ['brief-2026-10-21-abcd1234.mp3', 'brief-2026-10-21-ffff0000.wav'], { 'brief-2026-10-21-abcd1234.mp3': 2 }))
                .toEqual({ kind: 'whole' });
        });
        it('ignores a recorded revision of zero', () => {
            expect(legacyCoverageFor(d, ['brief-2026-10-21-abcd1234.mp3'], { 'brief-2026-10-21-abcd1234.mp3': 0 })).toEqual({ kind: 'whole' });
        });
    });
});

describe('a fresh install with four stored days', () => {
    it('plans every stored day in full, with the current revision and the brief as text', async () => {
        const s = await snap();
        expect(s.today).toBe(TODAY);
        expect(s.window).toHaveLength(7);
        expect(s.plan!.entries.map((e) => [e.date, e.kind, e.coverage])).toEqual([
            ['2026-10-20', 'full', { kind: 'revision', rev: 2 }],
            ['2026-10-21', 'full', { kind: 'revision', rev: 2 }],
            ['2026-10-22', 'full', { kind: 'revision', rev: 3 }],
            ['2026-10-23', 'full', { kind: 'revision', rev: 1 }],
        ]);
        expect(s.plan!.entries[0].text).toContain('Story 20 alpha');
        expect(s.plan!.entries[0].titles).toEqual(['Story 20 alpha', 'Story 20 beta']);
        expect(s.plan!.entries[0].newsletters).toBe(2);
        expect(s.plan!.from).toBe('2026-10-20');
        expect(s.plan!.to).toBe('2026-10-23');
    });

    it('reports the days with no stored newsletters neutrally', async () => {
        const s = await snap();
        expect(s.plan!.noStoredDates).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
        expect(s.oldestStoredDate).toBe('2026-10-20');
    });

    it('4+ pending days lift the cap to 20; the user ceiling can lower it', async () => {
        expect((await snap()).plan!.length.capMinutes).toBe(20);
        expect((await snap({ s: { newsletterCatchUpMaxMins: 10 } })).plan!.length.capMinutes).toBe(10);
    });

    it('fewer than 4 pending days aim for 15', async () => {
        vault.remove(`${ROOT}/Digest — 2026-10-20.md`);
        const s = await snap();
        expect(s.plan!.entries).toHaveLength(3);
        expect(s.plan!.length).toEqual({ capMinutes: 15, wordBudget: 1950 });
    });

    it('is a pure read: nothing is created, modified or trashed', async () => {
        await snap();
        expect(vault.app.vault.create).not.toHaveBeenCalled();
        expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
        expect(vault.app.vault.modify).not.toHaveBeenCalled();
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });
});

describe('coverage from episode notes', () => {
    it('days an episode covers are not pending', async () => {
        addEpisode(vault, episodeInput());
        const s = await snap();
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-22', '2026-10-23']);
        expect(s.latestEpisode?.id).toBe('20261022-081500-a1b2');
    });

    it('an episode with a deleted audio file covers nothing and is offered for regeneration', async () => {
        addEpisode(vault, episodeInput(), false);
        const s = await snap();
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
        expect(s.missingAudio).toHaveLength(1);
    });

    it('deleting the episode note rolls coverage back', async () => {
        addEpisode(vault, episodeInput());
        expect((await snap()).plan!.entries).toHaveLength(2);
        vault.remove(`${FOLDER}/${buildEpisodeName('2026-10-20', '2026-10-21', '20261022-081500-a1b2')}`);
        expect((await snap()).plan!.entries).toHaveLength(4);
    });

    it('late arrivals after coverage become a DELTA holding only the newer stories', async () => {
        addEpisode(vault, episodeInput({ from: '2026-10-22', to: '2026-10-22', coverage: { '2026-10-22': { kind: 'revision', rev: 1 } }, id: '20261022-090000-aaaa', audio: 'catchup-x.mp3' }));
        const s = await snap();
        const delta = s.plan!.entries.find((e) => e.date === '2026-10-22')!;
        expect(delta.kind).toBe('delta');
        expect(delta.sinceRevision).toBe(1);
        expect(delta.coverage).toEqual({ kind: 'revision', rev: 3 });
        expect(delta.text).toBe('- **Story 22 beta**: Gist for Story 22 beta');
        expect(delta.titles).toEqual(['Story 22 beta']);
    });

    it('a delta that cannot be itemised is unresolved and never reads as caught up', async () => {
        vault.remove(`${ROOT}/Digest — 2026-10-20.md`);
        vault.remove(`${ROOT}/Digest — 2026-10-21.md`);
        vault.remove(`${ROOT}/Digest — 2026-10-23.md`);
        addEpisode(vault, episodeInput({ from: '2026-10-22', to: '2026-10-22', coverage: { '2026-10-22': { kind: 'revision', rev: 1 } }, id: '20261022-090000-aaaa', audio: 'catchup-x.mp3' }));
        const s = await snap({ data: baseLedger({ '2026-10-22': ledgerBucket(3, [['Story 22 alpha', 1, 1]], { parseFailedAt: 5 }) }) });
        expect(s.plan).toBeNull();
        expect(s.pending.unresolved).toEqual([{ date: '2026-10-22', reason: 'unitemisable' }]);
        expect(s.state).toBe('unresolved-only');
    });

    it('a delta whose itemised text is empty is unresolved rather than dropped', async () => {
        addEpisode(vault, episodeInput({ from: '2026-10-22', to: '2026-10-22', coverage: { '2026-10-22': { kind: 'revision', rev: 3 } }, id: '20261022-090000-aaaa', audio: 'catchup-x.mp3' }));
        // ledger revision 4 but no story newer than 3
        const s = await snap({ data: baseLedger({ '2026-10-22': ledgerBucket(4, [['Story 22 alpha', 1, 1]]) }) });
        expect(s.pending.unresolved.map((u) => u.date)).toContain('2026-10-22');
        expect(s.plan!.entries.map((e) => e.date)).not.toContain('2026-10-22');
    });

    it('nothing pending when every stored day is covered', async () => {
        addEpisode(vault, episodeInput({ from: '2026-10-20', to: '2026-10-23', coverage: {
            '2026-10-20': { kind: 'revision', rev: 2 }, '2026-10-21': { kind: 'revision', rev: 2 },
            '2026-10-22': { kind: 'revision', rev: 3 }, '2026-10-23': { kind: 'revision', rev: 1 },
        }, id: '20261023-100000-bbbb', audio: 'catchup-y.mp3' }));
        const s = await snap();
        expect(s.plan).toBeNull();
        expect(s.state).toBe('caught-up');
    });

    it('a provable gap says so instead of "caught up"', async () => {
        // Every stored day is already narrated (legacy daily audio), so nothing is pending...
        for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
            vault.set(`${ROOT}/${d}/brief-${d}-abcd1234.mp3`, new ArrayBuffer(4));
        }
        // ...but the last catch-up ended on Oct 12, and Oct 13-19 are gone from the vault.
        addEpisode(vault, episodeInput({ from: '2026-10-10', to: '2026-10-12', coverage: { '2026-10-12': { kind: 'whole' } }, id: '20261012-100000-cccc', audio: 'catchup-z.mp3' }));
        const s = await snap();
        expect(s.plan).toBeNull();
        expect(s.latestEpisode?.to).toBe('2026-10-12');
        expect(s.oldestStoredDate).toBe('2026-10-20');
        expect(s.state).toBe('gap');
    });
});

describe('legacy daily audio is coverage only by provenance', () => {
    it('a legacy audio file with a recorded older revision leaves a delta for the late additions', async () => {
        vault.set(`${ROOT}/2026-10-22/brief-2026-10-22-abcd1234.mp3`, new ArrayBuffer(4));
        const ledger = baseLedger();
        (ledger['newsletter-story-ledger'].buckets['2026-10-22'].audio as Record<string, number>)['brief-2026-10-22-abcd1234.mp3'] = 1;
        const s = await snap({ data: ledger });
        const e = s.plan!.entries.find((x) => x.date === '2026-10-22')!;
        expect(e.kind).toBe('delta');
        expect(e.sinceRevision).toBe(1);
    });

    it('a stale embed with no audio file covers nothing', async () => {
        vault.set(`${ROOT}/Digest — 2026-10-22.md`, digest('2026-10-22', brief('22')).replace('# Newsletter Digest — 2026-10-22', '# Newsletter Digest — 2026-10-22\n\n🎧 **Listen:** ![[brief-2026-10-22-abcd1234.mp3]]'));
        const s = await snap();
        expect(s.plan!.entries.find((x) => x.date === '2026-10-22')!.kind).toBe('full');
    });

    it('a legacy audio file with expired provenance covers the day as whole', async () => {
        vault.set(`${ROOT}/2026-10-21/brief-2026-10-21-abcd1234.mp3`, new ArrayBuffer(4));
        const s = await snap();
        expect(s.plan!.entries.map((x) => x.date)).not.toContain('2026-10-21');
    });
});

describe('story memory off', () => {
    it('only CLOSED days are eligible and coverage is written as whole', async () => {
        const s = await snap({ s: { newsletterStoryMemory: false } });
        expect(s.memoryOn).toBe(false);
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
        expect(s.plan!.entries.every((e) => e.coverage.kind === 'whole')).toBe(true);
    });

    it('ignores ledger revisions entirely: a stored ledger does not change the plan', async () => {
        const withLedger = await snap({ s: { newsletterStoryMemory: false } });
        const without = await snap({ s: { newsletterStoryMemory: false }, data: {} });
        expect(withLedger.plan!.entries).toEqual(without.plan!.entries);
    });

    it('a never-covered day is still pending (no zero-revision trap) and a covered one is not re-offered', async () => {
        addEpisode(vault, episodeInput({ coverage: { '2026-10-20': { kind: 'whole' }, '2026-10-21': { kind: 'whole' } } }));
        const s = await snap({ s: { newsletterStoryMemory: false } });
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-22']);
    });
});

describe('automatic runs', () => {
    it('skip the still-open bucket', async () => {
        const s = await snap({ kind: 'auto' });
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
        expect(s.pending.openDates).toEqual(['2026-10-23']);
    });
});

describe('what the reader has not heard', () => {
    it('lists in-window episodes with no ack, independent of the watermark', async () => {
        addEpisode(vault, episodeInput());
        expect((await snap()).unheard.map((e) => e.id)).toEqual(['20261022-081500-a1b2']);
    });

    it('an ack clears it', async () => {
        addEpisode(vault, episodeInput());
        const data = { ...baseLedger(), 'newsletter-catchup-acks': { version: 1, acks: { '20261022-081500-a1b2': { ackedAt: 1, to: '2026-10-21' } } } };
        expect((await snap({ data })).unheard).toEqual([]);
    });
});

describe('window and retention', () => {
    it('the window is the lookback count of calendar dates, today included', async () => {
        const s = await snap({ s: { newsletterCatchUpLookbackDays: 3 } });
        expect(s.window).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
        expect(s.plan!.entries.map((e) => e.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    });

    it('retention clamps the lookback', async () => {
        const s = await snap({ s: { newsletterRetentionDays: 2 } });
        expect(s.window).toEqual(['2026-10-22', '2026-10-23']);
    });

    it('flags pending days that retention will remove within two days', async () => {
        // retention 6 on Oct 23: digests dated before Oct 17 are pruned today, before Oct 19 within two days.
        vault.set(`${ROOT}/Digest — 2026-10-18.md`, digest('2026-10-18', brief('18')));
        const s = await snap({ s: { newsletterRetentionDays: 6, newsletterCatchUpLookbackDays: 6 } });
        expect(s.plan!.entries.map((e) => e.date)).toContain('2026-10-18');
        expect(s.expiringDates).toEqual(['2026-10-18']);
    });

    it('retention 0 (keep forever) never flags expiry', async () => {
        const s = await snap({ s: { newsletterRetentionDays: 0 } });
        expect(s.expiringDates).toEqual([]);
    });
});
