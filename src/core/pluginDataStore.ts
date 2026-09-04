/**
 * Plugin Data Store — the ONLY module that calls `plugin.saveData`.
 *
 * Obsidian's `saveData` writes the ENTIRE plugin-data object. Read-modify-write
 * is therefore only safe when every writer is serialised: two writers that both
 * `loadData()` before either `saveData()`s will silently lose one update, even
 * when they touch completely different top-level keys. Separate keys give no
 * isolation whatsoever.
 *
 * Two writers live here, and the distinction is load-bearing:
 *
 *   - `saveSettingsData(plugin, settings)` — for settings saves. Replacement-based:
 *     it writes the settings object (minus any data-only keys that leaked into it)
 *     and re-attaches ONLY the registered `DATA_ONLY_KEYS` read fresh from disk.
 *     Replacement (not overlay) is deliberate: `migrateOldSettings` deletes legacy
 *     keys, and an overlay would resurrect them from disk forever, silently
 *     disabling every settings migration.
 *
 *   - `updatePluginData(plugin, mutator)` — for the non-settings data keys. The
 *     mutator reports whether it changed anything, so a no-op decision made
 *     *inside* the lock (e.g. "this revision is not newer, do nothing") skips the
 *     write entirely instead of churning the file.
 *
 * See docs/plans/newsletter-story-memory-local-news.md §7 for the writer matrix.
 */

import type { Plugin } from 'obsidian';
import { logger } from '../utils/logger';

/**
 * Top-level keys in `data.json` that are NOT settings.
 *
 * This registry is load-bearing: `saveSettingsData` preserves exactly these keys
 * and drops everything else, so a data store whose key is missing here would be
 * erased by the next settings save. `tests/pluginDataStore.test.ts` asserts that
 * the key literals used across `src/**` are exactly this set, so an unregistered
 * key fails CI rather than losing user data in the field.
 */
export const DATA_ONLY_KEYS = [
    'newsletter-seen-ids',
    'newsletter-last-auto-fetch',
    'newsletter-story-ledger',
    'newsletter-consumed-briefs',
] as const;

export type DataOnlyKey = (typeof DATA_ONLY_KEYS)[number];

/** Loose shape of the persisted plugin-data object. */
export type PluginData = Record<string, unknown>;

/** What a mutator reports back to the store. `changed:false` skips the write. */
export interface MutationOutcome<T> {
    changed: boolean;
    value?: T;
}

export type DataMutator<T> = (data: PluginData) => MutationOutcome<T>;

/**
 * Return a shallow copy of `obj` with every registered data-only key removed.
 *
 * Never mutates its argument. Used to keep data-only keys out of a settings
 * payload — `loadSettings` merges the whole loaded object into `settings`, so
 * without this the settings object carries a load-time snapshot of the data keys
 * and writing it back would roll them to a stale value.
 */
export function stripDataOnlyKeys<T extends object>(obj: T): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    for (const key of DATA_ONLY_KEYS) delete copy[key];
    return copy;
}

/**
 * Serialisation chain. Every write awaits the previous one, so `loadData` inside
 * a critical section always observes the previous writer's `saveData`.
 *
 * The tail is always a SETTLED promise: a rejecting operation must not poison
 * every later caller, so the chain is advanced in a `finally` and the stored tail
 * swallows the rejection (the rejection itself is still delivered to the caller
 * that owns it).
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    // Store a settled tail so one failure cannot wedge persistence for everyone.
    chain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/**
 * Serialised read-modify-write over the plugin-data object.
 *
 * The mutator is synchronous (so it cannot yield mid-critical-section) and
 * returns `{ changed, value }`. `saveData` runs only when `changed` is true.
 *
 * Resolves with the mutator's `value`, or `undefined` when it reported no change.
 */
export function updatePluginData<T = void>(
    plugin: Plugin,
    mutator: DataMutator<T>,
): Promise<T | undefined> {
    return enqueue(async () => {
        const data = ((await plugin.loadData()) ?? {}) as PluginData;
        const outcome = mutator(data);
        if (!outcome.changed) return outcome.value;
        await plugin.saveData(data);
        return outcome.value;
    });
}

/**
 * Serialised settings write.
 *
 * Writes `stripDataOnlyKeys(settings)` and re-attaches the registered data-only
 * keys read fresh from disk inside the lock, so a concurrent data-key write is
 * never clobbered and a settings migration's deletions still take effect.
 */
export function saveSettingsData(plugin: Plugin, settings: object): Promise<void> {
    return enqueue(async () => {
        const current = ((await plugin.loadData()) ?? {}) as PluginData;
        const next = stripDataOnlyKeys(settings);
        for (const key of DATA_ONLY_KEYS) {
            if (key in current) next[key] = current[key];
        }
        await plugin.saveData(next);
    });
}

/** Read the whole plugin-data object. Not serialised — reads need no lock. */
export async function loadPluginData(plugin: Plugin): Promise<PluginData> {
    try {
        return ((await plugin.loadData()) ?? {}) as PluginData;
    } catch (e) {
        // Callers degrade to defaults, which is correct, but a silent {} makes a
        // corrupt data.json indistinguishable from a first run.
        logger.warn('Core', 'Failed to read plugin data — callers will see defaults', e);
        return {};
    }
}

/** Test-only: reset the serialisation chain between test cases. */
export function __resetChainForTests(): void {
    chain = Promise.resolve();
}
