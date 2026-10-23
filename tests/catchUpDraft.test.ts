import { describe, it, expect, beforeEach } from 'vitest';
import {
    coerceRecord,
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
        saveData: async (d: Record<string, unknown>) => { state.stored = structuredClone(d); },
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
        const r = record({ phase: 'audio-ready', audio: { path: 'x/a.mp3', bytes: 10, durationSec: 5.5, sha256: 'ab' } });
        expect(coerceRecord(r)?.audio).toEqual({ path: 'x/a.mp3', bytes: 10, durationSec: 5.5, sha256: 'ab' });
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
        expect(await saveOperation(p as never, record({ phase: 'audio-writing' }))).toBe(true);
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
        expect(await ackEpisodes(p as never, [{ id: 'e1', to: '2026-10-22' }, { id: 'e2', to: '2026-10-22' }], '2026-10-23', 7)).toBe(1);
        expect(Object.keys(await loadAcks(p as never)).sort()).toEqual(['e1', 'e2']);
    });

    it('acking nothing is a no-op', async () => {
        const p = makePlugin();
        expect(await ackEpisodes(p as never, [], '2026-10-23', 7)).toBe(0);
        expect(p.state.stored).toEqual({});
    });
});
