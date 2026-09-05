import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    DATA_ONLY_KEYS,
    stripDataOnlyKeys,
    updatePluginData,
    saveSettingsData,
    loadPluginData,
    __resetChainForTests,
} from '../src/core/pluginDataStore';

/**
 * Fake plugin whose loadData/saveData deliberately model Obsidian's semantics:
 * `saveData` REPLACES the whole stored object, and both are async, so an
 * unserialised read-modify-write pair loses an update.
 */
function makePlugin(initial: Record<string, unknown> = {}) {
    let stored: Record<string, unknown> = structuredClone(initial);
    const calls = { load: 0, save: 0 };
    return {
        calls,
        get stored() { return stored; },
        loadData: async () => {
            calls.load++;
            await Promise.resolve();
            return structuredClone(stored);
        },
        saveData: async (data: Record<string, unknown>) => {
            calls.save++;
            await Promise.resolve();
            stored = structuredClone(data);
        },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
const asPlugin = (p: ReturnType<typeof makePlugin>) => p as any;

beforeEach(() => __resetChainForTests());

describe('stripDataOnlyKeys', () => {
    it('removes exactly the registered keys and copies rather than mutates', () => {
        const input = {
            maxTags: 5,
            'newsletter-seen-ids': ['a'],
            'newsletter-story-ledger': { version: 1 },
            'newsletter-last-auto-fetch': 123,
            'newsletter-consumed-briefs': { version: 1 },
        };
        const out = stripDataOnlyKeys(input);
        expect(out).toEqual({ maxTags: 5 });
        // original untouched
        expect(Object.keys(input)).toHaveLength(5);
    });

    it('is a no-op for an object with no data-only keys', () => {
        expect(stripDataOnlyKeys({ a: 1 })).toEqual({ a: 1 });
    });
});

describe('updatePluginData', () => {
    it('serialises concurrent writes to different keys so neither is lost', async () => {
        const plugin = makePlugin({});
        await Promise.all([
            updatePluginData(asPlugin(plugin), (d) => {
                d['newsletter-seen-ids'] = ['x'];
                return { changed: true };
            }),
            updatePluginData(asPlugin(plugin), (d) => {
                d['newsletter-story-ledger'] = { version: 1 };
                return { changed: true };
            }),
        ]);
        // The lost-update regression: without serialisation the second writer
        // loads before the first saves, and one key vanishes.
        expect(plugin.stored['newsletter-seen-ids']).toEqual(['x']);
        expect(plugin.stored['newsletter-story-ledger']).toEqual({ version: 1 });
    });

    it('runs mutators in call order', async () => {
        const plugin = makePlugin({});
        const order: number[] = [];
        await Promise.all([1, 2, 3].map((n) =>
            updatePluginData(asPlugin(plugin), (d) => {
                order.push(n);
                d['newsletter-seen-ids'] = [String(n)];
                return { changed: true };
            })));
        expect(order).toEqual([1, 2, 3]);
        expect(plugin.stored['newsletter-seen-ids']).toEqual(['3']);
    });

    it('skips saveData entirely when the mutator reports no change', async () => {
        const plugin = makePlugin({ a: 1 });
        const result = await updatePluginData<string>(asPlugin(plugin), () => ({ changed: false, value: 'skipped' }));
        expect(result).toBe('skipped');
        expect(plugin.calls.save).toBe(0);
    });

    it('returns the mutator value on a changed write', async () => {
        const plugin = makePlugin({});
        const result = await updatePluginData<number>(asPlugin(plugin), (d) => {
            d['newsletter-seen-ids'] = [];
            return { changed: true, value: 42 };
        });
        expect(result).toBe(42);
    });

    it('a throwing mutator rejects only its own call and does not wedge the chain', async () => {
        const plugin = makePlugin({});
        const bad = updatePluginData(asPlugin(plugin), () => { throw new Error('boom'); });
        await expect(bad).rejects.toThrow('boom');

        await updatePluginData(asPlugin(plugin), (d) => {
            d['newsletter-seen-ids'] = ['after'];
            return { changed: true };
        });
        expect(plugin.stored['newsletter-seen-ids']).toEqual(['after']);
    });
});

describe('saveSettingsData', () => {
    it('preserves data-only keys written concurrently and drops them from the payload', async () => {
        const plugin = makePlugin({ 'newsletter-seen-ids': ['keep-me'] });
        // A settings object still carrying a STALE snapshot of the data key —
        // the pre-fix shape that caused the rollback.
        const settings = { maxTags: 7, 'newsletter-seen-ids': ['stale'] };

        await saveSettingsData(asPlugin(plugin), settings);

        expect(plugin.stored.maxTags).toBe(7);
        expect(plugin.stored['newsletter-seen-ids']).toEqual(['keep-me']);
    });

    it('does not resurrect a legacy settings key that a migration deleted', async () => {
        const plugin = makePlugin({ maxTags: 3, ollamaEndpoint: 'http://old' });
        await saveSettingsData(asPlugin(plugin), { maxTags: 3 });
        // Replacement, not overlay: the migrated-away key must be gone.
        expect('ollamaEndpoint' in plugin.stored).toBe(false);
    });

    it('interleaves safely with a data-key write', async () => {
        const plugin = makePlugin({});
        await Promise.all([
            saveSettingsData(asPlugin(plugin), { maxTags: 9 }),
            updatePluginData(asPlugin(plugin), (d) => {
                d['newsletter-story-ledger'] = { version: 1 };
                return { changed: true };
            }),
        ]);
        expect(plugin.stored.maxTags).toBe(9);
        expect(plugin.stored['newsletter-story-ledger']).toEqual({ version: 1 });
    });
});

describe('loadPluginData', () => {
    it('returns {} when loadData throws', async () => {
        const plugin = { loadData: async () => { throw new Error('nope'); } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
        expect(await loadPluginData(plugin as any)).toEqual({});
    });
});

describe('DATA_ONLY_KEYS registry completeness', () => {
    // The registry is load-bearing: saveSettingsData preserves exactly these
    // keys and drops the rest, so an unregistered data key would be erased by
    // the next settings save. This test makes that failure loud at CI time.
    function walk(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full, out);
            else if (entry.endsWith('.ts')) out.push(full);
        }
        return out;
    }

    it('covers every plugin-data key declared or indexed in src/**', () => {
        // Two shapes count as "a plugin-data key":
        //   const SOMETHING_DATA_KEY = 'the-key'
        //   data['the-key']  /  data["the-key"]
        // Command ids, CSS classes and setting names are deliberately NOT
        // matched — only keys that actually address the plugin-data object.
        const DECL = /_DATA_KEY\s*=\s*['"]([^'"]+)['"]/g;
        const INDEX = /\bdata\[\s*['"]([^'"]+)['"]\s*\]/g;

        const found = new Set<string>();
        for (const file of walk('src')) {
            const normalised = file.replaceAll('\\', '/');
            if (normalised.endsWith('src/core/pluginDataStore.ts')) continue;
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(DECL)) found.add(m[1]);
            for (const m of text.matchAll(INDEX)) found.add(m[1]);
        }

        // Sanity check that the scan actually found something — an empty scan
        // would make this test vacuously pass forever.
        expect(found.size).toBeGreaterThan(0);

        const registered = new Set<string>(DATA_ONLY_KEYS);
        const unregistered = [...found].filter((k) => !registered.has(k)).sort();
        expect(unregistered).toEqual([]);
    });
});
