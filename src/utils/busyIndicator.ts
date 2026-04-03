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

const ACTIVE_CLASS = 'ai-organiser-busy-active';
const MIN_DISPLAY_MS = 400;

/**
 * Show the busy indicator. Increments ref count.
 * No-op if plugin.busyStatusBarEl is null (mobile).
 */
export function showBusy(plugin: { busyStatusBarEl: HTMLElement | null; t: { messages: { aiProcessing: string } } }, message?: string): void {
    refCount++;
    const el = plugin.busyStatusBarEl;
    if (!el) return;
    // Cancel any pending hide from a previous fast operation
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    if (refCount === 1) {
        showTimestamp = Date.now();
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
}
