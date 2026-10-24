import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    coerceRecord,
    storedRecordStatus,
    coerceAcks,
    pruneAcks,
    isRecordExpired,
    loadOperation,
    saveOperation,
    clearOperation,
    loadAcks,
    ackEpisodes,
    DRAFT_DATA_KEY,
    ACKS_DATA_KEY,
    RECORD_SCHEMA_VERSION,
    RECORD_TTL_MS,
    type OperationRecord,
} from '../src/services/newsletter/catchUp/catchUpDraft';
import { __resetChainForTests, DATA_ONLY_KEYS, stripDataOnlyKeys } from '../src/core/pluginDataStore';

function makePlugin(initial: Record<string, unknown> = {}) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return {
        state,
        loadData: async () => structuredClone(state.stored),
        saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }),
    };
}

function record(over: Partial<OperationRecord> = {}): OperationRecord {
    return {
        version: RECORD_SCHEMA_VERSION,
        opId: '20261023-081502-a1b2',
        phase: 'scripted',
        frozen: {
            entries: [
                { date: '2026-10-22', kind: 'full', coverage: { kind: 'revision', rev: 3 } },
                { date: '2026-10-23', kind: 'delta', coverage: { kind: 'whole' }, sinceRevision: 1 },
            ],
            from: '2026-10-22', to: '2026-10-23', sources: 5, titles: ['A fictional story'],
        },
        script: 'A synthetic script.',
        scriptIdentity: 'sid',
        outputRoot: 'AI-Organiser/Newsletter Inbox',
        capMinutes: 15,
        createdAt: 1000,
        ...over,
    };
}

beforeEach(() => { __resetChainForTests(); });

describe('registry', () => {
    it('both stores are data-only keys, so a settings save never erases them', () => {
        expect(DATA_ONLY_KEYS).toContain(DRAFT_DATA_KEY);
        expect(DATA_ONLY_KEYS).toContain(ACKS_DATA_KEY);
        const stripped = stripDataOnlyKeys({ a: 1, [DRAFT_DATA_KEY]: {}, [ACKS_DATA_KEY]: {} });
        expect(stripped).toEqual({ a: 1 });
    });
});

describe('coerceRecord', () => {
    it('accepts a valid record unchanged', () => {
        expect(coerceRecord(record())).toEqual(record());
    });

    it('keeps audio metadata when present', () => {
        const r = record({ phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 10, durationSec: 5.5, sha256: 'abababababababababababababababababababababababababababababababab' } });
        expect(coerceRecord(r)?.audio).toEqual({ path: 'x/a.mp3', bytes: 10, durationSec: 5.5, sha256: 'abababababababababababababababababababababababababababababababab' });
    });

    it.each([
        ['null', null],
        ['wrong version', { ...record(), version: 99 }],
        ['no op id', { ...record(), opId: '' }],
        ['no script', { ...record(), script: '' }],
        ['unknown phase', { ...record(), phase: 'planned' }],
        ['no entries', { ...record(), frozen: { ...record().frozen, entries: [] } }],
        ['bad entry', { ...record(), frozen: { ...record().frozen, entries: [{ date: 'x', kind: 'full', coverage: { kind: 'whole' } }] } }],
        ['zero revision', { ...record(), frozen: { ...record().frozen, entries: [{ date: '2026-10-22', kind: 'full', coverage: { kind: 'revision', rev: 0 } }] } }],
        ['bad range', { ...record(), frozen: { ...record().frozen, from: 'soon' } }],
    ])('rejects a corrupt record: %s', (_n, raw) => {
        expect(coerceRecord(raw)).toBeNull();
    });
});

describe('coerceRecord: validate, never manufacture', () => {
    const audioReady = { path: 'x/a.mp3', bytes: 10, durationSec: 5, sha256: 'abababababababababababababababababababababababababababababababab' };
    it.each([
        ['missing script identity', { ...record(), scriptIdentity: '' }],
        ['non-string script identity', { ...record(), scriptIdentity: 7 }],
        ['NaN timestamp', { ...record(), createdAt: Number.NaN }],
        ['Infinity timestamp', { ...record(), createdAt: Number.POSITIVE_INFINITY }],
        ['zero timestamp', { ...record(), createdAt: 0 }],
        ['string timestamp', { ...record(), createdAt: '1000' }],
        ['audio-writing without audio', { ...record(), phase: 'audio-writing' }],
        ['audio-ready without audio', { ...record(), phase: 'audio-ready' }],
        ['audio-ready without integrity evidence', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3' } }],
        ['audio-ready with a negative size', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: -1, durationSec: 1, sha256: 'abababababababababababababababababababababababababababababababab' } }],
        ['audio-ready with a zero size', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 0, durationSec: 1, sha256: 'abababababababababababababababababababababababababababababababab' } }],
        ['audio-ready with a fractional size', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 1.5, durationSec: 1, sha256: 'abababababababababababababababababababababababababababababababab' } }],
        ['audio-ready with a non-finite duration', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 1, durationSec: Number.POSITIVE_INFINITY, sha256: 'abababababababababababababababababababababababababababababababab' } }],
        ['audio-ready with a malformed hash', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 1, durationSec: 1, sha256: 'ab' } }],
        ['no output root', { ...record(), outputRoot: '' }],
        ['an output root that climbs', { ...record(), outputRoot: 'A/../B' }],
        ['no length limit', { ...record(), capMinutes: undefined }],
        ['an absurd length limit', { ...record(), capMinutes: 600 }],
        ['audio-ready without a hash', { ...record(), phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 1, durationSec: 1 } }],
        ['delta without a threshold', { ...record(), frozen: { ...record().frozen, entries: [{ date: '2026-10-22', kind: 'delta', coverage: { kind: 'whole' } }] } }],
        ['full day carrying a threshold', { ...record(), frozen: { ...record().frozen, entries: [{ date: '2026-10-22', kind: 'full', coverage: { kind: 'whole' }, sinceRevision: 1 }] } }],
        ['unknown entry kind', { ...record(), frozen: { ...record().frozen, entries: [{ date: '2026-10-22', kind: 'maybe', coverage: { kind: 'whole' } }] } }],
    ])('rejects %s', (_n, raw) => {
        expect(coerceRecord(raw)).toBeNull();
    });

    it('accepts a complete audio-ready record', () => {
        expect(coerceRecord(record({ phase: 'audio-ready', audio: audioReady }))?.audio).toEqual(audioReady);
    });
});

describe('a record from a newer plugin is preserved', () => {
    const future = { version: 2, opId: 'future', script: 'from the future' };

    it('is classified as unsupported, not corrupt', () => {
        expect(storedRecordStatus(future)).toBe('unsupported');
        expect(storedRecordStatus(null)).toBe('none');
        expect(storedRecordStatus({ version: 1, junk: true })).toBe('corrupt');
        expect(storedRecordStatus('x')).toBe('corrupt');
        // An OLDER schema is not another plugin's record: nothing here can use it, so it is not preserved.
        expect(storedRecordStatus({ version: 0, opId: 'old' })).toBe('corrupt');
        expect(storedRecordStatus(record())).toBe('valid');
    });

    it('save refuses to overwrite it and clear refuses to remove it', async () => {
        const p = makePlugin({ [DRAFT_DATA_KEY]: future });
        expect(await saveOperation(p as never, record())).toBe(false);
        expect(await saveOperation(p as never, record(), 'future')).toBe(false);
        expect(await clearOperation(p as never, 'future')).toBe(false);
        expect(p.state.stored[DRAFT_DATA_KEY]).toEqual(future);
    });
});

describe('expiry', () => {
    it('expires after the TTL', () => {
        expect(isRecordExpired(record({ createdAt: 0 }), RECORD_TTL_MS)).toBe(false);
        expect(isRecordExpired(record({ createdAt: 0 }), RECORD_TTL_MS + 1)).toBe(true);
    });
});

describe('operation record: compare-and-set', () => {
    it('saves into an empty store and reads it back', async () => {
        const p = makePlugin();
        expect(await saveOperation(p as never, record())).toBe(true);
        expect(await loadOperation(p as never)).toEqual(record());
    });

    it('updates its own record (same op id)', async () => {
        const p = makePlugin();
        await saveOperation(p as never, record());
        expect(await saveOperation(p as never, record({ phase: 'audio-writing', audio: { path: 'x/a.mp3' } }))).toBe(true);
        expect((await loadOperation(p as never))?.phase).toBe('audio-writing');
    });

    it("refuses to overwrite another operation's record", async () => {
        const p = makePlugin();
        await saveOperation(p as never, record());
        const other = record({ opId: '20261023-090000-ffff', script: 'someone else' });
        expect(await saveOperation(p as never, other)).toBe(false);
        expect((await loadOperation(p as never))?.script).toBe('A synthetic script.');
    });

    it('replaces another record only when the caller names it (explicit Start over)', async () => {
        const p = makePlugin();
        await saveOperation(p as never, record());
        const other = record({ opId: '20261023-090000-ffff', script: 'fresh' });
        expect(await saveOperation(p as never, other, '20261023-081502-a1b2')).toBe(true);
        expect((await loadOperation(p as never))?.opId).toBe('20261023-090000-ffff');
        // naming the WRONG record does not unlock a replacement
        expect(await saveOperation(p as never, record(), 'nope')).toBe(false);
    });

    it('clear is conditional on the owner', async () => {
        const p = makePlugin();
        await saveOperation(p as never, record());
        expect(await clearOperation(p as never, 'someone-else')).toBe(false);
        expect(await loadOperation(p as never)).not.toBeNull();
        expect(await clearOperation(p as never, '20261023-081502-a1b2')).toBe(true);
        expect(await loadOperation(p as never)).toBeNull();
        expect(DRAFT_DATA_KEY in p.state.stored).toBe(false);
    });

    it('clear on an empty store is a no-op that writes nothing', async () => {
        const p = makePlugin();
        expect(await clearOperation(p as never, 'x')).toBe(false);
    });

    it('a corrupt stored value has no owner and can be replaced', async () => {
        const p = makePlugin({ [DRAFT_DATA_KEY]: { version: 1, junk: true } });
        expect(await saveOperation(p as never, record())).toBe(true);
    });

    it('preserves unrelated plugin data', async () => {
        const p = makePlugin({ keep: 1 });
        await saveOperation(p as never, record());
        await clearOperation(p as never, record().opId);
        expect(p.state.stored.keep).toBe(1);
    });
});

describe('acknowledgements', () => {
    it('round-trips through coerce', () => {
        expect(coerceAcks({ version: 1, acks: { a: { ackedAt: 5, to: '2026-10-20' } } })).toEqual({ a: { ackedAt: 5, to: '2026-10-20' } });
    });

    it('drops malformed entries and unknown versions', () => {
        expect(coerceAcks({ version: 2, acks: {} })).toEqual({});
        expect(coerceAcks({ version: 1, acks: { a: { to: 'soon' }, b: 'x', c: { ackedAt: 1, to: '2026-10-20' } } })).toEqual({ c: { ackedAt: 1, to: '2026-10-20' } });
        expect(coerceAcks(null)).toEqual({});
    });

    it('prunes acks older than the lookback plus 30 days, and keeps newer ones', () => {
        const acks = { old: { ackedAt: 1, to: '2026-08-01' }, fresh: { ackedAt: 1, to: '2026-10-10' } };
        expect(Object.keys(pruneAcks(acks, '2026-10-23', 7))).toEqual(['fresh']);
    });

    it('works with story memory off: the ack store has no dependency on the watermark', async () => {
        const p = makePlugin();
        expect(await ackEpisodes(p as never, [{ id: 'e1', to: '2026-10-22' }], '2026-10-23', 7)).toBe(1);
        expect(await loadAcks(p as never)).toEqual({ e1: { ackedAt: expect.any(Number), to: '2026-10-22' } });
        expect(Object.keys(p.state.stored)).toEqual([ACKS_DATA_KEY]);
    });

    it('acking twice writes once', async () => {
        const p = makePlugin();
        await ackEpisodes(p as never, [{ id: 'e1', to: '2026-10-22' }], '2026-10-23', 7);
        p.saveData.mockClear();
        expect(await ackEpisodes(p as never, [{ id: 'e1', to: '2026-10-22' }], '2026-10-23', 7)).toBe(0);
        expect(p.saveData).not.toHaveBeenCalled();
        expect(await ackEpisodes(p as never, [{ id: 'e1', to: '2026-10-22' }, { id: 'e2', to: '2026-10-22' }], '2026-10-23', 7)).toBe(1);
        expect(p.saveData).toHaveBeenCalledTimes(1);
        expect(Object.keys(await loadAcks(p as never)).sort()).toEqual(['e1', 'e2']);
    });

    it('acking nothing is a no-op that writes nothing', async () => {
        const p = makePlugin();
        expect(await ackEpisodes(p as never, [], '2026-10-23', 7)).toBe(0);
        expect(p.state.stored).toEqual({});
        expect(p.saveData).not.toHaveBeenCalled();
    });

    it('a retention-only change IS persisted (expired acks are removed even when nothing is added)', async () => {
        const p = makePlugin({ [ACKS_DATA_KEY]: { version: 1, acks: { old: { ackedAt: 1, to: '2026-08-01' }, fresh: { ackedAt: 1, to: '2026-10-10' } } } });
        const n = await ackEpisodes(p as never, [{ id: 'fresh', to: '2026-10-10' }], '2026-10-23', 7);
        expect(n).toBe(0);
        expect(p.saveData).toHaveBeenCalledTimes(1);
        expect(Object.keys(await loadAcks(p as never))).toEqual(['fresh']);
    });

    it('additions and removals in the same call persist together', async () => {
        const p = makePlugin({ [ACKS_DATA_KEY]: { version: 1, acks: { old: { ackedAt: 1, to: '2026-08-01' } } } });
        expect(await ackEpisodes(p as never, [{ id: 'new', to: '2026-10-22' }], '2026-10-23', 7)).toBe(1);
        expect(Object.keys(await loadAcks(p as never))).toEqual(['new']);
    });
});

describe('per-day titles in a stored record', () => {
    it('a record made before them has none, so it keeps the original episode template', () => {
        const coerced = coerceRecord(structuredClone(record()));
        expect(coerced).not.toBeNull();
        expect('dayTitles' in coerced!.frozen).toBe(false);
    });

    it('survives a round trip', () => {
        const r = record();
        r.frozen.dayTitles = [{ date: '2026-10-22', titles: ['A fictional story'] }, { date: '2026-10-23', titles: [] }];
        expect(coerceRecord(structuredClone(r))!.frozen.dayTitles).toEqual(r.frozen.dayTitles);
    });

    it('drops malformed days without rejecting the record', () => {
        const raw = structuredClone(record()) as unknown as { frozen: Record<string, unknown> };
        raw.frozen.dayTitles = [{ date: '2026-10-22', titles: ['ok', 7] }, { date: 'yesterday', titles: ['x'] }, { date: '2026-10-23' }, null, 'junk'];
        const coerced = coerceRecord(raw);
        expect(coerced).not.toBeNull();
        expect(coerced!.frozen.dayTitles).toEqual([{ date: '2026-10-22', titles: ['ok'] }]);
    });
});
