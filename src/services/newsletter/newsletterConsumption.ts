/**
 * Newsletter Consumption Watermark — what the reader has actually CONSUMED.
 *
 * Independent of the ledger by design. Suppressing a story is only correct
 * relative to what the reader has heard, not to what was published: a reader who
 * is three days behind and then binge-listens must not have those three days
 * silently omitted, and once they catch up the next brief must adapt.
 *
 * Consumption is REVISION-SCOPED, not a per-bucket boolean. A live bucket's
 * brief is regenerated on every fetch, so a boolean would mark stories that
 * arrived after the reader listened as already heard.
 */

import type { Plugin } from 'obsidian';
import { updatePluginData, loadPluginData } from '../../core/pluginDataStore';
import {
    MEMORY_SCHEMA_VERSION,
    MEMORY_WINDOW_DAYS,
    emptyConsumption,
    type ConsumptionRecord,
    type ConsumptionSignal,
    type ConsumptionState,
    type StoryLedger,
} from './newsletterMemoryTypes';
import { shiftDateStr } from './newsletterStoryLedger';

export const CONSUMED_DATA_KEY = 'newsletter-consumed-briefs';

/** Consumption keys are YYYY-MM-DD; anything else is corruption. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The revision the reader has consumed for a bucket, or null. Pure. */
export function consumedRevision(state: ConsumptionState, dateStr: string): number | null {
    const rec = state.consumed[dateStr];
    return rec ? rec.revision : null;
}

/** Drop records outside the rolling window. Pure. */
export function pruneConsumption(
    state: ConsumptionState,
    todayStr: string,
    windowDays = MEMORY_WINDOW_DAYS,
): ConsumptionState {
    const cutoff = shiftDateStr(todayStr, -windowDays);
    const consumed: Record<string, ConsumptionRecord> = {};
    for (const [date, rec] of Object.entries(state.consumed)) {
        if (date >= cutoff) consumed[date] = rec;
    }
    return { version: MEMORY_SCHEMA_VERSION, consumed };
}

/** Coerce whatever is on disk into a valid state. Unknown version = discard. */
export function coerceConsumption(raw: unknown): ConsumptionState {
    if (!raw || typeof raw !== 'object') return emptyConsumption();
    const obj = raw as Partial<ConsumptionState>;
    if (obj.version !== MEMORY_SCHEMA_VERSION) return emptyConsumption();
    if (!obj.consumed || typeof obj.consumed !== 'object') return emptyConsumption();

    const consumed: Record<string, ConsumptionRecord> = {};
    for (const [date, value] of Object.entries(obj.consumed)) {
        if (!value || typeof value !== 'object') continue;
        const r = value as Partial<ConsumptionRecord>;
        if (!DATE_KEY_RE.test(date)) continue;
        if (!Number.isFinite(r.revision) || (r.revision as number) < 0) continue;
        const lastAt = typeof r.lastAt === 'number' ? r.lastAt : 0;
        const lastVia: ConsumptionSignal = r.lastVia === 'manual' || r.lastVia === 'audio' ? r.lastVia : 'manual';
        consumed[date] = {
            firstAt: typeof r.firstAt === 'number' ? r.firstAt : lastAt,
            lastAt,
            firstVia: r.firstVia === 'manual' || r.firstVia === 'audio' ? r.firstVia : lastVia,
            lastVia,
            revision: r.revision as number,
        };
    }
    return { version: MEMORY_SCHEMA_VERSION, consumed };
}

export async function loadConsumption(plugin: Plugin): Promise<ConsumptionState> {
    const data = await loadPluginData(plugin);
    return coerceConsumption(data[CONSUMED_DATA_KEY]);
}

/**
 * Advance a bucket's consumption watermark.
 *
 * Advances ONLY on a strictly higher revision, so replaying an old recording
 * writes nothing. `firstAt` / `firstVia` are never overwritten — an advance
 * records that the reader came back, not that they arrived for the first time.
 *
 * Returns true when the store changed.
 */
export async function markBucketConsumed(
    plugin: Plugin,
    dateStr: string,
    via: ConsumptionSignal,
    revision: number,
    todayStr: string = dateStr,
): Promise<boolean> {
    const changed = await updatePluginData<boolean>(plugin, (data) => {
        const state = pruneConsumption(coerceConsumption(data[CONSUMED_DATA_KEY]), todayStr);
        const existing = state.consumed[dateStr];
        if (existing && revision <= existing.revision) {
            return { changed: false, value: false };
        }
        const now = Date.now();
        state.consumed[dateStr] = existing
            ? { ...existing, lastAt: now, lastVia: via, revision }
            : { firstAt: now, lastAt: now, firstVia: via, lastVia: via, revision };
        data[CONSUMED_DATA_KEY] = state;
        return { changed: true, value: true };
    });
    return changed === true;
}

export interface CatchUpResult {
    buckets: number;
    stories: number;
}

/**
 * Manual catch-up: record every in-window bucket at or before `throughDateStr`
 * at that bucket's CURRENT ledger revision.
 *
 * Unlike the audio signal this is an explicit user assertion ("I am up to date"),
 * so consuming the current revision is correct rather than a guess.
 */
export async function markAllConsumedThrough(
    plugin: Plugin,
    throughDateStr: string,
    ledger: StoryLedger,
): Promise<CatchUpResult> {
    const result = await updatePluginData<CatchUpResult>(plugin, (data) => {
        const state = pruneConsumption(coerceConsumption(data[CONSUMED_DATA_KEY]), throughDateStr);
        let buckets = 0;
        let stories = 0;
        const now = Date.now();

        // The window applies to INCOMING writes too, not just to already-stored
        // state. Pruning and then iterating every ledger bucket would let an
        // out-of-window bucket be reintroduced as consumed on the way back in.
        const cutoff = shiftDateStr(throughDateStr, -MEMORY_WINDOW_DAYS);
        for (const [date, bucket] of Object.entries(ledger.buckets)) {
            if (date > throughDateStr || date < cutoff) continue;
            const existing = state.consumed[date];
            if (existing && bucket.revision <= existing.revision) continue;
            state.consumed[date] = existing
                ? { ...existing, lastAt: now, lastVia: 'manual', revision: bucket.revision }
                : { firstAt: now, lastAt: now, firstVia: 'manual', lastVia: 'manual', revision: bucket.revision };
            buckets++;
            stories += bucket.stories.length;
        }

        if (buckets === 0) return { changed: false, value: { buckets: 0, stories: 0 } };
        data[CONSUMED_DATA_KEY] = state;
        return { changed: true, value: { buckets, stories } };
    });
    return result ?? { buckets: 0, stories: 0 };
}

/** Remove all consumption data. Used when the feature is switched off. */
export async function clearConsumption(plugin: Plugin): Promise<void> {
    await updatePluginData(plugin, (data) => {
        if (!(CONSUMED_DATA_KEY in data)) return { changed: false };
        delete data[CONSUMED_DATA_KEY];
        return { changed: true };
    });
}
