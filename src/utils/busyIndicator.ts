/**
 * Global LLM Busy Indicator
 * Ref-counted status bar spinner that shows when any LLM operation is in progress.
 * Uses ref counting to handle concurrent operations — show on first, hide when all complete.
 */

let refCount = 0;

const ACTIVE_CLASS = 'ai-organiser-busy-active';

/**
 * Show the busy indicator. Increments ref count.
 * No-op if plugin.busyStatusBarEl is null (mobile).
 */
export function showBusy(plugin: { busyStatusBarEl: HTMLElement | null; t: { messages: { aiProcessing: string } } }, message?: string): void {
    refCount++;
    const el = plugin.busyStatusBarEl;
    if (!el) return;
    el.setText(message || plugin.t.messages.aiProcessing);
    el.addClass(ACTIVE_CLASS);
}

/**
 * Hide the busy indicator. Decrements ref count, removes class only at 0.
 * No-op if plugin.busyStatusBarEl is null (mobile).
 */
export function hideBusy(plugin: { busyStatusBarEl: HTMLElement | null }): void {
    if (refCount > 0) refCount--;
    if (refCount === 0) {
        const el = plugin.busyStatusBarEl;
        if (!el) return;
        el.removeClass(ACTIVE_CLASS);
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
}
