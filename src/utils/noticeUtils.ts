/**
 * Notice helpers — shared interactive Notice patterns.
 *
 * Plan: docs/plans/ux-frontend-fixes.md (FIX-06)
 *
 * Why a helper: at least three feature-gated toasts ("semantic search not
 * enabled", "newsletter not enabled", etc.) share the "click to open settings"
 * shape. Centralising here keeps the typed cast for `app.setting` in one place
 * (no `@ts-ignore` per Obsidian Bot rule) and gives us a single seam for
 * future a11y/scroll-to-section improvements.
 */

import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';

interface SettingApi { open(): void; openTabById(id: string): void }
interface AppWithSetting { setting?: SettingApi }

const DESKTOP_TIMEOUT_MS = 8000;
const MOBILE_TIMEOUT_MS = 12000;

/**
 * Show a Notice with a "Open settings" CTA that jumps the user to the plugin
 * settings tab when clicked. Falls back to a plain text Notice if the helper
 * cannot host an interactive button (defensive — Obsidian's Notice has
 * accepted DocumentFragment for years, but the fallback covers older builds
 * and any future API tightening).
 *
 * @param plugin   AI Organiser plugin instance — used for app, manifest, t
 * @param message  Localized message text (sentence case)
 * @param timeoutMs  Optional override; defaults to 8000 desktop / 12000 mobile
 * @returns The created Notice, in case the caller wants to hide it early
 */
export function noticeWithSettingsLink(
    plugin: AIOrganiserPlugin,
    message: string,
    timeoutMs?: number,
): Notice {
    const timeout = timeoutMs ?? (Platform.isMobile ? MOBILE_TIMEOUT_MS : DESKTOP_TIMEOUT_MS);
    const buttonLabel = plugin.t.common?.openSettings ?? 'Open settings';

    try {
        const fragment = document.createDocumentFragment();
        const wrapper = document.createElement('div');
        wrapper.className = 'ai-organiser-notice-with-action';
        fragment.appendChild(wrapper);

        const messageEl = document.createElement('p');
        messageEl.className = 'ai-organiser-notice-message';
        messageEl.textContent = message;
        wrapper.appendChild(messageEl);

        const button = document.createElement('button');
        button.className = 'ai-organiser-notice-settings-link mod-cta';
        button.textContent = buttonLabel;
        button.setAttribute('aria-label', buttonLabel);
        wrapper.appendChild(button);

        const notice = new Notice(fragment, timeout);
        button.addEventListener('click', () => {
            const api = (plugin.app as unknown as AppWithSetting).setting;
            if (api && typeof api.open === 'function' && typeof api.openTabById === 'function') {
                api.open();
                api.openTabById(plugin.manifest.id);
            }
            notice.hide();
        });
        return notice;
    } catch {
        // Defensive fallback — plain Notice still surfaces the message.
        return new Notice(message, timeout);
    }
}
