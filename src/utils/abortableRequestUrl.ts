/**
 * abortableRequestUrl
 * -------------------
 * "Soft cancel" wrapper around Obsidian's requestUrl. Native requestUrl does
 * NOT honor AbortSignal at the socket level — the underlying HTTP request
 * keeps running in the Electron process. This utility races the request
 * against a signal-triggered rejection so the caller stops awaiting
 * immediately, and attaches a terminal .catch() to the losing promise so a
 * late rejection from the background request is not orphaned (Gemini-M2).
 *
 * For flows that require HARD cancel (in-flight socket close visible in
 * Network tab as "cancelled"), use native fetch() directly with the signal.
 * See docs/plans/progress-reporter.md §3.2 for the tier table.
 */

import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

export interface AbortableRequestUrlOptions {
    signal?: AbortSignal;
}

/** Run requestUrl, but reject early if the signal fires. The underlying
 *  request continues in the background on abort — its eventual rejection
 *  (if any) is swallowed to avoid unhandled-rejection warnings. */
export async function abortableRequestUrl(
    params: RequestUrlParam,
    options?: AbortableRequestUrlOptions,
): Promise<RequestUrlResponse> {
    const signal = options?.signal;
    if (!signal) return requestUrl(params);

    if (signal.aborted) {
        throw new DOMException('cancelled', 'AbortError');
    }

    const requestPromise = requestUrl(params);

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => reject(new DOMException('cancelled', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
        return await Promise.race([requestPromise, abortPromise]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        // Swallow any late rejection from the losing request so it doesn't
        // trigger unhandledrejection. Silent catch is correct — caller has
        // moved on.
        requestPromise.catch(() => { /* orphan swallow — see module doc */ });
    }
}
