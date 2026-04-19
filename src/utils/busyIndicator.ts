/**
 * Global LLM Busy Indicator
 * Ref-counted status bar spinner that shows when any LLM operation is in progress.
 * Uses ref counting to handle concurrent operations — show on first, hide when all complete.
 * Minimum display duration (400ms) ensures the spinner is always perceptible,
 * even for fast LLM responses (e.g., tagging).
 */

let refCount = 0;
let showTimestamp = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Watchdog that force-clears refCount when the spinner has been visible far
 *  longer than any legitimate LLM operation should run. Guards against leaked
 *  refs from code paths that forgot to call hideBusy (persona round 4 P3 #16). */
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let lastEl: HTMLElement | null = null;

const ACTIVE_CLASS = 'ai-organiser-busy-active';
const MIN_DISPLAY_MS = 400;
/** 10 minutes — any real LLM call should settle (or be aborted) well before
 *  this. If we're still busy after this, assume a ref leak and force-reset. */
const WATCHDOG_MS = 10 * 60 * 1000;

/**
 * Show the busy indicator. Increments ref count.
 * No-op if plugin.busyStatusBarEl is null (mobile).
 */
export function showBusy(plugin: { busyStatusBarEl: HTMLElement | null; t: { messages: { aiProcessing: string } } }, message?: string): void {
    refCount++;
    const el = plugin.busyStatusBarEl;
    if (!el) return;
    lastEl = el;
    // Cancel any pending hide from a previous fast operation
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    if (refCount === 1) {
        showTimestamp = Date.now();
        // Arm watchdog so a leaked ref can't pin the spinner forever
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
            watchdogTimer = null;
            if (refCount > 0) {
                refCount = 0;
                lastEl?.removeClass(ACTIVE_CLASS);
            }
        }, WATCHDOG_MS);
    }
    el.setText(message || plugin.t.messages.aiProcessing);
    el.addClass(ACTIVE_CLASS);
}

/**
 * Hide the busy indicator. Decrements ref count, removes class only at 0.
 * Enforces minimum display duration so the spinner is always visible.
 * No-op if plugin.busyStatusBarEl is null (mobile).
 */
export function hideBusy(plugin: { busyStatusBarEl: HTMLElement | null }): void {
    if (refCount > 0) refCount--;
    if (refCount === 0) {
        // Cancel watchdog — refCount dropped naturally, no leak
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }
        const elapsed = Date.now() - showTimestamp;
        const remaining = MIN_DISPLAY_MS - elapsed;
        if (remaining > 0) {
            // Defer hide so spinner is visible for at least MIN_DISPLAY_MS
            hideTimer = setTimeout(() => {
                hideTimer = null;
                const el = plugin.busyStatusBarEl;
                if (!el) return;
                // Only hide if no new operation started while we waited
                if (refCount === 0) {
                    el.removeClass(ACTIVE_CLASS);
                }
            }, remaining);
        } else {
            const el = plugin.busyStatusBarEl;
            if (!el) return;
            el.removeClass(ACTIVE_CLASS);
        }
    }
}

/**
 * Wrap an async operation with the busy indicator.
 * Shows spinner before, hides after (even on error).
 */
export async function withBusyIndicator<T>(
    plugin: { busyStatusBarEl: HTMLElement | null; t: { messages: { aiProcessing: string } } },
    operation: () => Promise<T>,
    message?: string
): Promise<T> {
    showBusy(plugin, message);
    try {
        return await operation();
    } finally {
        hideBusy(plugin);
    }
}

/**
 * Reset busy state to 0. Call on plugin unload.
 */
export function resetBusyState(): void {
    refCount = 0;
    showTimestamp = 0;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
    }
    lastEl = null;
}
