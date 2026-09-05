import { describe, it, expect, beforeEach } from 'vitest';
import {
    CONSUMED_DATA_KEY,
    consumedRevision,
    pruneConsumption,
    coerceConsumption,
    markBucketConsumed,
    markAllConsumedThrough,
    clearConsumption,
    loadConsumption,
} from '../src/services/newsletter/newsletterConsumption';
import {
    MEMORY_SCHEMA_VERSION,
    type ConsumptionState,
    type StoryLedger,
} from '../src/services/newsletter/newsletterMemoryTypes';
import { __resetChainForTests } from '../src/core/pluginDataStore';

function makePlugin(initial: Record<string, unknown> = {}) {
    let stored = structuredClone(initial);
    return {
        get stored() { return stored; },
        loadData: async () => structuredClone(stored),
        saveData: async (d: Record<string, unknown>) => { stored = structuredClone(d); },
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
const asPlugin = (p: ReturnType<typeof makePlugin>) => p as any;

const MON = '2026-08-31';
const TUE = '2026-09-01';

function ledgerWith(buckets: Record<string, { revision: number; count: number }>): StoryLedger {
    const out: StoryLedger = { version: MEMORY_SCHEMA_VERSION, buckets: {} };
    for (const [date, b] of Object.entries(buckets)) {
        out.buckets[date] = {
            revision: b.revision,
            updatedAt: 0,
            audio: {},
            stories: Array.from({ length: b.count }, (_, i) => ({
                key: `k${i}`, title: `T${i}`, gist: 'g', firstRevision: 1, contentRevision: 1,
            })),
        };
    }
    return out;
}

beforeEach(() => __resetChainForTests());

describe('coerceConsumption', () => {
    it('discards an unknown schema version', () => {
        expect(coerceConsumption({ version: 99, consumed: { x: {} } }).consumed).toEqual({});
    });

    it('returns empty state for garbage', () => {
        expect(coerceConsumption(undefined).consumed).toEqual({});
        expect(coerceConsumption('nope').consumed).toEqual({});
    });

    it('back-fills first* from last* on a record missing them', () => {
        const out = coerceConsumption({
            version: MEMORY_SCHEMA_VERSION,
            consumed: { [MON]: { lastAt: 500, lastVia: 'audio', revision: 3 } },
        });
        expect(out.consumed[MON]).toEqual({
            firstAt: 500, lastAt: 500, firstVia: 'audio', lastVia: 'audio', revision: 3,
        });
    });

    it('drops a record with no revision', () => {
        const out = coerceConsumption({
            version: MEMORY_SCHEMA_VERSION,
            consumed: { [MON]: { lastAt: 1, lastVia: 'audio' } },
        });
        expect(out.consumed).toEqual({});
    });
});

describe('consumedRevision / pruneConsumption', () => {
    const state: ConsumptionState = {
        version: MEMORY_SCHEMA_VERSION,
        consumed: {
            '2026-09-04': { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 2 },
            '2026-08-20': { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 },
        },
    };

    it('returns the revision or null', () => {
        expect(consumedRevision(state, '2026-09-04')).toBe(2);
        expect(consumedRevision(state, '2026-09-03')).toBeNull();
    });

    it('drops records outside the window', () => {
        const out = pruneConsumption(state, '2026-09-04', 7);
        expect(Object.keys(out.consumed)).toEqual(['2026-09-04']);
    });
});

describe('markBucketConsumed', () => {
    it('creates a record on first consumption', async () => {
        const p = makePlugin();
        expect(await markBucketConsumed(asPlugin(p), MON, 'audio', 1)).toBe(true);
        const rec = (p.stored[CONSUMED_DATA_KEY] as ConsumptionState).consumed[MON];
        expect(rec.revision).toBe(1);
        expect(rec.firstVia).toBe('audio');
    });

    it('ADVANCES on a strictly higher revision, preserving firstAt/firstVia', async () => {
        const p = makePlugin();
        await markBucketConsumed(asPlugin(p), MON, 'audio', 1);
        const first = (p.stored[CONSUMED_DATA_KEY] as ConsumptionState).consumed[MON];

        expect(await markBucketConsumed(asPlugin(p), MON, 'manual', 3)).toBe(true);
        const rec = (p.stored[CONSUMED_DATA_KEY] as ConsumptionState).consumed[MON];
        expect(rec.revision).toBe(3);
        expect(rec.lastVia).toBe('manual');
        expect(rec.firstVia).toBe('audio');
        expect(rec.firstAt).toBe(first.firstAt);
    });

    it('is a genuine no-op for an equal or lower revision', async () => {
        // Replaying an old recording must not churn the store.
        const p = makePlugin();
        await markBucketConsumed(asPlugin(p), MON, 'audio', 3);
        const snapshot = structuredClone(p.stored);

        expect(await markBucketConsumed(asPlugin(p), MON, 'audio', 3)).toBe(false);
        expect(await markBucketConsumed(asPlugin(p), MON, 'audio', 1)).toBe(false);
        expect(p.stored).toEqual(snapshot);
    });
});

describe('markAllConsumedThrough', () => {
    it('records every in-window bucket at its current ledger revision', async () => {
        const p = makePlugin();
        const result = await markAllConsumedThrough(
            asPlugin(p), TUE,
            ledgerWith({ [MON]: { revision: 2, count: 3 }, [TUE]: { revision: 1, count: 2 } }),
        );
        expect(result).toEqual({ buckets: 2, stories: 5 });
        const state = p.stored[CONSUMED_DATA_KEY] as ConsumptionState;
        expect(state.consumed[MON].revision).toBe(2);
        expect(state.consumed[TUE].lastVia).toBe('manual');
    });

    it('ignores buckets after the through-date', async () => {
        const p = makePlugin();
        const result = await markAllConsumedThrough(
            asPlugin(p), MON,
            ledgerWith({ [MON]: { revision: 1, count: 1 }, [TUE]: { revision: 1, count: 1 } }),
        );
        expect(result.buckets).toBe(1);
        expect((p.stored[CONSUMED_DATA_KEY] as ConsumptionState).consumed[TUE]).toBeUndefined();
    });

    it('returns a zero result and writes nothing when already caught up', async () => {
        const p = makePlugin();
        const l = ledgerWith({ [MON]: { revision: 1, count: 1 } });
        await markAllConsumedThrough(asPlugin(p), MON, l);
        const snapshot = structuredClone(p.stored);

        expect(await markAllConsumedThrough(asPlugin(p), MON, l)).toEqual({ buckets: 0, stories: 0 });
        expect(p.stored).toEqual(snapshot);
    });

    it('returns a zero result for an empty ledger', async () => {
        const p = makePlugin();
        expect(await markAllConsumedThrough(asPlugin(p), MON, ledgerWith({}))).toEqual({ buckets: 0, stories: 0 });
    });
});

describe('clearConsumption / loadConsumption', () => {
    it('round-trips and then clears', async () => {
        const p = makePlugin();
        await markBucketConsumed(asPlugin(p), MON, 'audio', 1);
        expect(consumedRevision(await loadConsumption(asPlugin(p)), MON)).toBe(1);

        await clearConsumption(asPlugin(p));
        expect(CONSUMED_DATA_KEY in p.stored).toBe(false);
        expect(consumedRevision(await loadConsumption(asPlugin(p)), MON)).toBeNull();
    });
});
