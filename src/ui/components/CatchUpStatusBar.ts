/**
 * CatchUpStatusBar — "N days pending", the daily entry point to newsletter audio.
 *
 * Desktop only (a phone has no status bar; it uses the command and the picker). Clicking it
 * opens the catch-up window. Refreshes are COALESCED — many triggers (a fetch, a vault event,
 * a settings save) collapse into one read pass — and the item is hidden whenever it has
 * nothing honest to say.
 */

import { Platform, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { isFeatureEnabled } from '../../services/featureService';
import { isCatchUpEnabled } from '../../services/newsletter/newsletterAudioMode';
import { buildCatchUpSnapshot } from '../../services/newsletter/catchUp/catchUpSelection';
import { deriveWaiting, pendingCounts } from '../../services/newsletter/catchUp/catchUpModalState';
import { formatPendingSummary } from '../../services/newsletter/catchUp/catchUpFormat';
import { logger } from '../../utils/logger';

const COALESCE_MS = 1000;

/** Whether the item may show at all — pure, so every hiding rule is a unit test. */
export function statusBarWanted(settings: Parameters<typeof isFeatureEnabled>[0] & {
    newsletterAudioPodcast?: boolean;
    newsletterAudioMode?: unknown;
    newsletterCatchUpStatusBar?: boolean;
}): boolean {
    return isFeatureEnabled(settings, 'newsletter')
        && isCatchUpEnabled(settings)
        && settings.newsletterCatchUpStatusBar !== false;
}

export class CatchUpStatusBar {
    private el: HTMLElement | null = null;
    private timer: number | null = null;
    private running = false;
    private dirty = false;
    private disposed = false;

    constructor(private readonly plugin: AIOrganiserPlugin) {}

    /** Create the item once. A no-op on mobile. */
    mount(): void {
        if (Platform.isMobile || this.el || typeof this.plugin.addStatusBarItem !== 'function') return;
        const el = this.plugin.addStatusBarItem();
        el.addClass('ai-organiser-catchup-status');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.hide();
        const open = (): void => { this.plugin.openCatchUpWindow?.(); };
        el.addEventListener('click', open);
        el.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        this.el = el;
    }

    /** Ask for a refresh. Many calls in a second cost one read pass. */
    refresh(): void {
        if (this.disposed || !this.el) return;
        if (this.timer !== null) return;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.run();
        }, COALESCE_MS);
    }

    private async run(): Promise<void> {
        if (this.running) { this.dirty = true; return; }
        this.running = true;
        try {
            await this.update();
        } catch (e) {
            logger.warn('Newsletter', 'Catch-up status refresh failed', e);
            this.el?.hide();
        } finally {
            this.running = false;
            if (this.dirty && !this.disposed) { this.dirty = false; this.refresh(); }
        }
    }

    private async update(): Promise<void> {
        const el = this.el;
        if (!el) return;
        if (!statusBarWanted(this.plugin.settings)) { el.hide(); return; }

        const snapshot = await buildCatchUpSnapshot({ app: this.plugin.app, plugin: this.plugin, settings: this.plugin.settings });
        // The read took time: settings may have turned the item off, or it may be gone.
        if (this.disposed || !statusBarWanted(this.plugin.settings)) { el.hide(); return; }
        const { days, newsletters } = pendingCounts(snapshot);
        const unheard = snapshot.unheard.length;
        const m = this.plugin.t.modals.newsletterCatchUp;

        // Smart daily is holding back: say so, not just "1 not listened".
        const waiting = deriveWaiting(snapshot, this.plugin.settings);
        let label: string;
        if (waiting) {
            const pending = (waiting.days === 1 ? m.daysOne : m.daysMany).replace('{n}', String(waiting.days));
            label = (waiting.episodes.length > 1 ? m.statusBarWaitingMany : m.statusBarWaiting)
                .replace('{count}', String(waiting.episodes.length)).replace('{pending}', m.waitingPending.replace('{days}', pending));
        } else if (days > 0) {
            const summary = formatPendingSummary(this.plugin.t, days, newsletters);
            label = unheard > 0 ? `${m.statusBarLabel.replace('{summary}', summary)} · ${m.statusBarUnheard.replace('{n}', String(unheard))}` : m.statusBarLabel.replace('{summary}', summary);
        } else if (unheard > 0) {
            label = m.statusBarUnheard.replace('{n}', String(unheard));
        } else {
            el.hide();
            return;
        }

        el.empty();
        const icon = el.createSpan({ cls: 'ai-organiser-catchup-status-icon' });
        setIcon(icon, 'headphones');
        el.createSpan({ text: ` ${label}` });
        // The left-out count is in the accessible name too: a native tooltip is not reliably shown on keyboard focus.
        const leftOut = snapshot.skipped.filter((s) => s.reason === 'heard-daily-audio').length;
        const leftOutText = leftOut > 0 ? m.statusBarSkipped.replace('{n}', String(leftOut)) : '';
        el.setAttribute('aria-label', leftOutText ? `${label}. ${leftOutText}` : label);
        const tip = waiting ? (waiting.episodes.length > 1 ? m.waitingEndsMany : m.waitingEndsOne) : m.statusBarTooltip;
        el.setAttribute('title', leftOutText ? `${tip}. ${leftOutText}` : tip);
        el.show();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
        this.el?.remove();
        this.el = null;
    }
}
