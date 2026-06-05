/**
 * Run up to `limit` async tasks concurrently while preserving result order.
 *
 * A bounded worker pool: `limit` workers pull from a shared cursor, so at most
 * `limit` `fn` invocations are in flight at once. Results land at their original
 * index. Workers check the optional abort signal BEFORE picking up the next item,
 * so a mid-run abort stops queued work promptly (it does not cancel an in-flight
 * `fn` — that's the caller's responsibility via the same signal).
 *
 * Extracted from `audioNarration/llmMarkdownEnhancer.ts` (audit-code H7) so brand
 * asset resolution and the LLM enhancer share one bounded-fan-out primitive
 * instead of each rolling an unbounded `Promise.all`.
 */
export async function mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    limit: number,
    fn: (item: TItem, index: number) => Promise<TResult>,
    signal?: AbortSignal,
): Promise<TResult[]> {
    const results: TResult[] = new Array(items.length);
    let next = 0;
    const bound = Math.max(1, Math.min(limit, items.length));
    async function worker(): Promise<void> {
        while (true) {
            if (signal?.aborted) return; // drop queued work on abort
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: bound }, () => worker()));
    return results;
}
