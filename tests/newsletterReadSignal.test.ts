import { describe, it, expect, vi } from 'vitest';
import {
    BRIEF_END_MARKER,
    BRIEF_START_MARKER,
    READ_DATA_KEY,
    buildObservation,
    buildReadCredit,
    clearReadState,
    coerceReadState,
    commitReadObservation,
    countNewlyRead,
    creditPair,
    hashPart,
    pruneReadState,
    readAppliesToBucket,
    readProjectionsForBucket,
    extractBriefBlock,
    type ReadCommitGuard,
} from '../src/services/newsletter/newsletterReadSignal';
import { selectRecall, selectGenerationRecalls } from '../src/services/newsletter/newsletterRecall';
import {
    MEMORY_SCHEMA_VERSION,
    type ConsumptionState,
    type LedgerStory,
    type ReadState,
    type StoryLedger,
} from '../src/services/newsletter/newsletterMemoryTypes';
import { recallForCatchUp } from '../src/services/newsletter/catchUp/catchUpPrompts';

const D1 = '2026-10-19';
const D2 = '2026-10-20';
const D3 = '2026-10-21';

function st(key: string, gist = `gist ${key}`, rev = 1, first = rev): LedgerStory {
    return { key, title: key.toUpperCase(), gist, firstRevision: first, contentRevision: rev };
}
function ledger(b: Record<string, { revision: number; stories: LedgerStory[] }>): StoryLedger {
    const out: StoryLedger = { version: MEMORY_SCHEMA_VERSION, buckets: {} };
    for (const [d, v] of Object.entries(b)) out.buckets[d] = { revision: v.revision, updatedAt: 0, audio: {}, stories: v.stories };
    return out;
}
const none: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
function heard(map: Record<string, number>): ConsumptionState {
    const s: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
    for (const [d, revision] of Object.entries(map)) s.consumed[d] = { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision };
    return s;
}
function readOf(date: string, stories: LedgerStory[]): ReadState {
    return { version: MEMORY_SCHEMA_VERSION, read: { [date]: { via: 'explicit', credited: stories.map(creditPair) } } };
}
const keys = (l: { key: string }[]) => l.map((s) => s.key).sort();

describe('hashPart / creditPair', () => {
    it('is deterministic, 12 hex, and distinguishes inputs', () => {
        expect(hashPart('abc')).toBe(hashPart('abc'));
        expect(hashPart('abc')).toMatch(/^[0-9a-f]{12}$/);
        expect(hashPart('abc')).not.toBe(hashPart('abd'));
    });
    it('credit pair ignores gist whitespace/case (the ledger fingerprint) but not content', () => {
        expect(creditPair(st('a', 'Rates  HELD'))).toEqual(creditPair(st('a', 'rates held')));
        expect(creditPair(st('a', 'rates held'))).not.toEqual(creditPair(st('a', 'rates cut')));
    });
});

describe('buildReadCredit — content match', () => {
    const bucket = ledger({ [D1]: { revision: 2, stories: [st('port-strike-harbour', 'talks resume', 2), st('rate-decision-central-bank', 'rates held')] } }).buckets[D1];

    it('credits only content-identical stories', () => {
        const c = buildReadCredit(bucket, [
            { key: 'port-strike-harbour', title: 'Port strike', gist: 'talks resume' },
            { key: 'rate-decision-central-bank', title: 'Rates', gist: 'rates cut' },
        ]);
        expect(c.map((x) => x.story.key)).toEqual(['port-strike-harbour']);
    });
    it('a renamed headline is located by similarity but still needs the same gist', () => {
        const ok = buildReadCredit(bucket, [{ key: 'harbour-port-strike-talks', title: 'x', gist: 'talks resume' }]);
        expect(ok.map((x) => x.story.key)).toEqual(['port-strike-harbour']);
        const stale = buildReadCredit(bucket, [{ key: 'harbour-port-strike-talks', title: 'x', gist: 'dockers walked out' }]);
        expect(stale).toEqual([]);
    });
    it('a story the model omitted from the displayed brief earns nothing', () => {
        expect(buildReadCredit(bucket, [{ key: 'unrelated', title: 'x', gist: 'y' }])).toEqual([]);
    });
    it('empty/absent bucket or empty display credits nothing', () => {
        expect(buildReadCredit(undefined, [{ key: 'a', title: 'a', gist: 'g' }])).toEqual([]);
        expect(buildReadCredit(bucket, [])).toEqual([]);
    });
    it('two divergent ledgers with the same revision number: the foreign record cannot credit unseen stories', () => {
        const mine = ledger({ [D1]: { revision: 3, stories: [st('story x'), st('story y')] } });
        const theirs = ledger({ [D1]: { revision: 3, stories: [st('story x')] } });
        const read = readOf(D1, theirs.buckets[D1].stories);
        const sel = selectRecall(mine, none, D2, {}, read);
        expect(keys(sel.heard)).toEqual(['story x']);
        expect(keys(sel.unheard)).toEqual(['story y']);
    });
});

describe('observation from a note', () => {
    const note = `# Digest\n\n${BRIEF_START_MARKER}\n## Daily Brief\n\n### Business\n- **Rate decision central bank**: Rates held. (Sources: A, B)\n\n${BRIEF_END_MARKER}\n\n- [[x]]`;
    it('extracts the managed block and parses its stories', () => {
        expect(extractBriefBlock(note)).toContain('Rate decision');
        const o = buildObservation(D1, note);
        expect(o?.observation.displayed).toHaveLength(1);
        expect(o?.observation.date).toBe(D1);
    });
    it('returns null without a block or with unparseable text', () => {
        expect(buildObservation(D1, '# no brief here')).toBeNull();
        expect(buildObservation(D1, `${BRIEF_START_MARKER}\n${'prose without bullets '.repeat(30)}\n${BRIEF_END_MARKER}`)).toBeNull();
    });
    it('a different brief text yields a different hash', () => {
        const a = buildObservation(D1, note)!;
        const b = buildObservation(D1, note.replace('Rates held', 'Rates cut'))!;
        expect(a.textHash).not.toBe(b.textHash);
    });
});

describe('store: coerce / prune / projections', () => {
    it('coerce discards corruption and unknown versions', () => {
        expect(coerceReadState(null).read).toEqual({});
        expect(coerceReadState({ version: 99, read: { [D1]: { via: 'explicit', credited: [['a', 'b']] } } }).read).toEqual({});
        const good = creditPair(st('a'));
        const s = coerceReadState({ version: 1, read: { [D1]: { via: 'bogus', credited: [good, ['zz', 'zz'], 'x', good] }, 'not-a-date': { credited: [good] } } });
        expect(Object.keys(s.read)).toEqual([D1]);
        expect(s.read[D1].credited).toEqual([good]);
        expect(s.read[D1].via).toBe('explicit');
    });
    it('prunes outside the window', () => {
        const s = readOf('2026-10-01', [st('a')]);
        expect(pruneReadState(s, '2026-10-21').read).toEqual({});
        expect(Object.keys(pruneReadState(readOf(D1, [st('a')]), D3).read)).toEqual([D1]);
    });
    it('projections are per bucket and split key/text', () => {
        const s = readOf(D1, [st('a', 'g1')]);
        const p = readProjectionsForBucket(s, D1)!;
        const [k, g] = creditPair(st('a', 'g1'));
        expect(p.keys.has(k)).toBe(true);
        expect(p.texts.has(`${k}.${g}`)).toBe(true);
        expect(readProjectionsForBucket(s, D2)).toBeUndefined();
        expect(readProjectionsForBucket(undefined, D1)).toBeUndefined();
    });
});

describe('recall join with the read channel', () => {
    it('a prior-day story read at its current text is heard; it shrinks the unheard list', () => {
        const l = ledger({ [D1]: { revision: 1, stories: [st('a'), st('b')] } });
        const sel = selectRecall(l, none, D2, {}, readOf(D1, [st('a')]));
        expect(keys(sel.heard)).toEqual(['a']);
        expect(keys(sel.unheard)).toEqual(['b']);
    });
    it('a gist change after the read keeps the background: continuing, never unheard', () => {
        const l = ledger({ [D1]: { revision: 2, stories: [st('a', 'new development', 2, 1)] } });
        const sel = selectRecall(l, none, D2, {}, readOf(D1, [st('a', 'old text')]));
        expect(keys(sel.continuing)).toEqual(['a']);
        expect(sel.unheard).toHaveLength(0);
    });
    it('omitted read ⇒ identical to the heard-only selection', () => {
        const l = ledger({ [D1]: { revision: 1, stories: [st('a'), st('b')] }, [D2]: { revision: 1, stories: [st('c')] } });
        expect(selectRecall(l, heard({ [D1]: 1 }), D3)).toEqual(selectRecall(l, heard({ [D1]: 1 }), D3, {}, undefined));
    });
    it('same-day reads are ignored (scope seam)', () => {
        const l = ledger({ [D2]: { revision: 1, stories: [st('a')] } });
        const sel = selectRecall(l, none, D2, {}, readOf(D2, [st('a')]));
        expect(keys(sel.unheard)).toEqual(['a']);
        expect(readAppliesToBucket(D1, D2)).toBe(true);
        expect(readAppliesToBucket(D2, D2)).toBe(false);
        expect(readAppliesToBucket(D3, D2)).toBe(false);
    });
    it("today's read cannot leak into a prior-day occurrence of the same running story", () => {
        const l = ledger({ [D1]: { revision: 1, stories: [st('running story')] }, [D2]: { revision: 1, stories: [st('running story', 'day two text')] } });
        const sel = selectRecall(l, none, D2, {}, readOf(D2, [st('running story', 'day two text')]));
        expect(keys(sel.unheard)).toEqual(['running story']);
        expect(sel.heard).toHaveLength(0);
        expect(sel.continuing).toHaveLength(0);
    });
    it('read AND heard classify exactly as either alone (no double counting)', () => {
        const l = ledger({ [D1]: { revision: 2, stories: [st('a', 'g', 1), st('b', 'g2', 2)] } });
        const both = selectRecall(l, heard({ [D1]: 2 }), D2, {}, readOf(D1, l.buckets[D1].stories));
        const onlyHeard = selectRecall(l, heard({ [D1]: 2 }), D2);
        const onlyRead = selectRecall(l, none, D2, {}, readOf(D1, l.buckets[D1].stories));
        expect(both).toEqual(onlyHeard);
        expect(both).toEqual(onlyRead);
    });
    it('the audio recall stays heard-only; the brief recall sees the read', () => {
        const l = ledger({ [D1]: { revision: 1, stories: [st('a')] } });
        const r = readOf(D1, [st('a')]);
        const { briefRecall, audioRecall } = selectGenerationRecalls(l, none, D2, r);
        expect(keys(briefRecall.heard)).toEqual(['a']);
        expect(keys(audioRecall.unheard)).toEqual(['a']);
        expect(selectGenerationRecalls(l, none, D2).briefRecall).toEqual(audioRecall);
    });
    it('catch-up recall (which never receives a read state) is unchanged by a populated read store', () => {
        const l = ledger({ [D1]: { revision: 1, stories: [st('a')] } });
        const viaCatchUp = recallForCatchUp(selectRecall(l, none, D2), new Set<string>());
        expect(keys(viaCatchUp!.unheard)).toEqual(['a']);
    });
});

describe('countNewlyRead — idempotent', () => {
    const c = [st('a'), st('b', 'g', 2)].map((story) => ({ story, pair: creditPair(story) }));
    it('counts all when nothing is recorded or heard', () => expect(countNewlyRead(undefined, c, null)).toBe(2));
    it('is 0 on a second identical mark', () => {
        expect(countNewlyRead({ via: 'explicit', credited: c.map((x) => x.pair) }, c, null)).toBe(0);
    });
    it('excludes stories already heard', () => expect(countNewlyRead(undefined, c, 1)).toBe(1));
});

// ── commit through the real plugin-data store ───────────────────────────────

function pluginWith(data: Record<string, unknown>, opts: { failSave?: boolean } = {}) {
    const store = structuredClone(data);
    const saveData = vi.fn(async (d: Record<string, unknown>) => {
        if (opts.failSave) throw new Error('disk full');
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, structuredClone(d));
    });
    return { plugin: { loadData: vi.fn(async () => structuredClone(store)), saveData } as never, store, saveData };
}
function guard(over: Partial<ReadCommitGuard> = {}): ReadCommitGuard {
    let gen = 0;
    return { eligible: () => true, generation: 0, currentGeneration: () => gen, ...over, ...(over.currentGeneration ? {} : { currentGeneration: () => gen }) };
}
const LEDGER_KEY = 'newsletter-story-ledger';
const L = ledger({ [D1]: { revision: 1, stories: [st('a'), st('b')] } });
const obs = (stories: LedgerStory[]) => ({ date: D1, displayed: stories.map((s) => ({ key: s.key, title: s.title, gist: s.gist })) });

describe('commitReadObservation', () => {
    it('credits, persists, and reports newly read', async () => {
        const { plugin, store } = pluginWith({ [LEDGER_KEY]: L });
        const r = await commitReadObservation(plugin, obs([st('a'), st('b')]), 'explicit', guard(), D2);
        expect(r).toEqual({ ok: true, value: { kind: 'credited', stories: 2, newly: 2 } });
        expect(Object.keys(store)).toContain(READ_DATA_KEY);
        const again = await commitReadObservation(plugin, obs([st('a'), st('b')]), 'explicit', guard(), D2);
        expect(again).toEqual({ ok: true, value: { kind: 'noop' } });
    });
    it('a second mark never shrinks the credit and reports 0 new', async () => {
        const { plugin } = pluginWith({ [LEDGER_KEY]: L });
        await commitReadObservation(plugin, obs([st('a')]), 'explicit', guard(), D2);
        const r = await commitReadObservation(plugin, obs([st('a'), st('b')]), 'read-through', guard(), D2);
        expect(r).toEqual({ ok: true, value: { kind: 'credited', stories: 2, newly: 1 } });
    });
    it('reports 0 newly for a bucket that was already heard', async () => {
        const { plugin } = pluginWith({ [LEDGER_KEY]: L, 'newsletter-consumed-briefs': heard({ [D1]: 1 }) });
        const r = await commitReadObservation(plugin, obs([st('a'), st('b')]), 'explicit', guard(), D2);
        expect(r).toEqual({ ok: true, value: { kind: 'credited', stories: 2, newly: 0 } });
    });
    it('refuses when nothing matches, when ineligible, and when the generation moved', async () => {
        const { plugin, store } = pluginWith({ [LEDGER_KEY]: L });
        expect(await commitReadObservation(plugin, obs([st('zzz')]), 'explicit', guard(), D2)).toEqual({ ok: true, value: { kind: 'refused', code: 'no-matching-stories' } });
        expect(await commitReadObservation(plugin, obs([st('a')]), 'explicit', guard({ eligible: () => false }), D2)).toEqual({ ok: true, value: { kind: 'refused', code: 'mode-off' } });
        expect(await commitReadObservation(plugin, obs([st('a')]), 'explicit', { eligible: () => true, generation: 0, currentGeneration: () => 1 }, D2)).toEqual({ ok: true, value: { kind: 'refused', code: 'invalidated' } });
        expect(READ_DATA_KEY in store).toBe(false);
    });
    it('a purge cannot be undone by a session that qualified earlier', async () => {
        const { plugin, store } = pluginWith({ [LEDGER_KEY]: L });
        let gen = 0;
        const g: ReadCommitGuard = { eligible: () => true, generation: 0, currentGeneration: () => gen };
        await commitReadObservation(plugin, obs([st('a')]), 'explicit', g, D2);
        await clearReadState(plugin);
        gen = 1; // the purge bumped the generation
        const late = await commitReadObservation(plugin, obs([st('b')]), 'read-through', g, D2);
        expect(late).toEqual({ ok: true, value: { kind: 'refused', code: 'invalidated' } });
        expect(READ_DATA_KEY in store).toBe(false);
    });
    it('wraps a rejected save into Result.err and records nothing', async () => {
        const { plugin, store } = pluginWith({ [LEDGER_KEY]: L }, { failSave: true });
        const r = await commitReadObservation(plugin, obs([st('a')]), 'explicit', guard(), D2);
        expect(r.ok).toBe(false);
        expect(READ_DATA_KEY in store).toBe(false);
    });
    it('clearReadState wraps failures too', async () => {
        const { plugin } = pluginWith({ [READ_DATA_KEY]: readOf(D1, [st('a')]) }, { failSave: true });
        expect((await clearReadState(plugin)).ok).toBe(false);
    });
});
