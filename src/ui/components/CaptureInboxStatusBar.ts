/**
 * "N captures to review" in the status bar, the daily entry point to the capture queue.
 *
 * Desktop only (a phone has no status bar; it uses the command and the picker). Hidden whenever it has
 * nothing to say. Refreshes are coalesced, like the catch-up item.
 */
import { Platform } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { CaptureController } from '../../services/captureInbox/captureController';
import { queueCounts } from '../../services/captureInbox/captureQueueModel';
import { plural } from '../../utils/plural';

const COALESCE_MS = 500;

/** The text shown for a queue snapshot, or null when the item should be hidden. Pure. */
export function statusText(
    counts: { toReview: number; waiting: number; failed?: number },
    t: { statusReview: string; statusWaiting: string; statusFailed?: string },
): string | null {
    const failed = counts.failed ?? 0;
    if (counts.toReview === 0 && counts.waiting === 0 && failed === 0) return null;
    const parts: string[] = [];
    if (counts.toReview > 0) parts.push(plural(t.statusReview, counts.toReview));
    if (failed > 0 && t.statusFailed) parts.push(t.statusFailed.replace('{count}', String(failed)));
    if (counts.waiting > 0) parts.push(t.statusWaiting.replace('{count}', String(counts.waiting)));
    return parts.join(' · ');
}

export class CaptureInboxStatusBar {
    private el: HTMLElement | null = null;
    private timer: number | null = null;
    private unsubscribe: (() => void) | null = null;
    private disposed = false;

    constructor(private readonly plugin: AIOrganiserPlugin, private readonly ctl: CaptureController) {}

    mount(): void {
        if (Platform.isMobile || this.el || typeof this.plugin.addStatusBarItem !== 'function') return;
        const el = this.plugin.addStatusBarItem();
        el.addClass('ai-organiser-capture-status');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', this.plugin.t.captureInbox.statusTooltip);
        el.hide();
        const open = (): void => this.ctl.openQueue();
        el.addEventListener('click', open);
        el.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        this.el = el;
        this.unsubscribe = this.ctl.store.subscribe(() => this.refresh());
        this.refresh();
    }

    refresh(): void {
        if (this.disposed || !this.el || this.timer !== null) return;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.update();
        }, COALESCE_MS);
    }

    private update(): void {
        const el = this.el;
        if (!el || this.disposed) return;
        const text = statusText(queueCounts(this.ctl.store.get()), this.plugin.t.captureInbox);
        if (text === null) { el.hide(); return; }
        el.setText(text);
        el.show();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.unsubscribe?.();
        this.el?.remove();
        this.el = null;
    }
}
