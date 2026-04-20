/**
 * Tag Progress Status Bar (Phase 5)
 *
 * Compact status-bar indicator for the Smart Tag batch loop. Shows live
 * progress ("Tagging 12/500 · 1m 30s") + an inline Cancel × button.
 * Lives in Obsidian's status bar (like native sync / word count) so users
 * can keep working in the vault while tagging runs — no modal overlay.
 *
 * Auto-dismisses itself when disposed. Graceful-degrades on mobile where
 * `plugin.addStatusBarItem()` is not available: we fall back to rotating
 * Notices (the existing behaviour in main.ts before Phase 5).
 */

import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export interface TagProgressStatusBar {
    update(current: number, total: number, elapsedMs: number): void;
    dispose(): void;
}

/**
 * Factory: creates a status bar item (desktop) or a rotating-Notice fallback
 * (mobile). Returns a common interface so the caller doesn't branch.
 *
 * @param plugin      Host plugin — provides addStatusBarItem and t
 * @param onCancel    Clicked Cancel → called exactly once
 * @param onExpand    Optional — invoked when user clicks the main label
 *                    (reserved for future expanded panel). Ignored if
 *                    undefined.
 */
export function createTagProgressStatusBar(
    plugin: AIOrganiserPlugin,
    onCancel: () => void,
    onExpand?: () => void,
): TagProgressStatusBar {
    const t = plugin.t.smartTag;

    // Mobile fallback: no status bar, use non-intrusive Notices. These are
    // refreshed in update() so the user sees progress.
    if (Platform.isMobile || !plugin.addStatusBarItem) {
        return createNoticeFallback(plugin, onCancel);
    }

    const container = plugin.addStatusBarItem();
    container.addClass('ai-organiser-tag-progress-statusbar');

    const labelEl = container.createSpan({ cls: 'ai-organiser-tag-progress-label' });
    labelEl.textContent = t?.progressStarting || 'Tagging…';

    if (onExpand) {
        labelEl.addClass('ai-organiser-tag-progress-label-clickable');
        labelEl.addEventListener('click', onExpand);
    }

    const cancelBtn = container.createEl('button', {
        cls: 'ai-organiser-tag-progress-cancel',
        attr: { type: 'button', 'aria-label': t?.cancelLabel || 'Cancel tagging' },
    });
    cancelBtn.textContent = '✕';
    let cancelled = false;
    cancelBtn.addEventListener('click', () => {
        if (cancelled) return;
        cancelled = true;
        cancelBtn.disabled = true;
        onCancel();
    });

    let disposed = false;
    return {
        update(current: number, total: number, elapsedMs: number): void {
            if (disposed) return;
            const template = t?.progressLabel || 'Tagging {current}/{total} · {elapsed}';
            labelEl.textContent = template
                .replace('{current}', String(current))
                .replace('{total}', String(total))
                .replace('{elapsed}', formatElapsed(elapsedMs));
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            container.remove();
        },
    };
}

/**
 * Mobile fallback — no status bar available. We re-use the pre-Phase-5
 * Notice-based progress (throttled to every 15s). Cancel is exposed via
 * an always-visible persistent Notice with a click handler.
 */
function createNoticeFallback(
    plugin: AIOrganiserPlugin,
    onCancel: () => void,
): TagProgressStatusBar {
    const t = plugin.t.smartTag;
    // Persistent cancel Notice.
    const cancelNotice = new Notice(t?.cancelMobileHint || 'Tap here to cancel tagging', 0);
    let cancelled = false;
    cancelNotice.messageEl?.addEventListener('click', () => {
        if (cancelled) return;
        cancelled = true;
        onCancel();
    });

    let lastShown = 0;
    let disposed = false;
    return {
        update(current: number, total: number, elapsedMs: number): void {
            if (disposed) return;
            const now = Date.now();
            if (now - lastShown < 15_000) return;
            lastShown = now;
            const msg = (t?.progressLabel || 'Tagging {current}/{total} · {elapsed}')
                .replace('{current}', String(current))
                .replace('{total}', String(total))
                .replace('{elapsed}', formatElapsed(elapsedMs));
            new Notice(msg, 3000);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            cancelNotice.hide();
        },
    };
}

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0
        ? `${min}m ${sec.toString().padStart(2, '0')}s`
        : `${sec}s`;
}
