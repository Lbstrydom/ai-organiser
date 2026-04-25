/**
 * @vitest-environment happy-dom
 *
 * noticeWithSettingsLink unit tests.
 *
 * Plan: docs/plans/ux-frontend-fixes.md (FIX-06)
 * Acceptance: clicking the toast button opens the plugin settings tab.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const noticeInstances: Array<{ message: unknown; timeout?: number; hide: ReturnType<typeof vi.fn> }> = [];

vi.mock('obsidian', () => ({
    Notice: class MockNotice {
        message: unknown;
        timeout?: number;
        hide = vi.fn();
        constructor(message: unknown, timeout?: number) {
            this.message = message;
            this.timeout = timeout;
            noticeInstances.push(this);
        }
    },
    Platform: { isMobile: false },
}));

import { noticeWithSettingsLink } from '../src/utils/noticeUtils';

function makePlugin(opts: { settingApiPresent?: boolean; openSettingsLabel?: string } = {}) {
    const open = vi.fn();
    const openTabById = vi.fn();
    return {
        plugin: {
            app: opts.settingApiPresent === false ? {} : { setting: { open, openTabById } },
            manifest: { id: 'ai-organiser' },
            t: { common: opts.openSettingsLabel === undefined
                ? { openSettings: 'Open settings' }
                : { openSettings: opts.openSettingsLabel } },
        } as never,
        open,
        openTabById,
    };
}

describe('noticeWithSettingsLink', () => {
    beforeEach(() => {
        noticeInstances.length = 0;
        vi.clearAllMocks();
    });

    it('creates a Notice with a DocumentFragment carrying the message + button', () => {
        const ctx = makePlugin();
        const notice = noticeWithSettingsLink(ctx.plugin, 'Semantic search is not enabled.');
        expect(noticeInstances).toHaveLength(1);
        const fragment = noticeInstances[0].message as DocumentFragment;
        expect(fragment).toBeInstanceOf(DocumentFragment);
        const wrapper = fragment.querySelector('.ai-organiser-notice-with-action');
        expect(wrapper).toBeTruthy();
        expect(wrapper?.querySelector('.ai-organiser-notice-message')?.textContent).toBe('Semantic search is not enabled.');
        const button = wrapper?.querySelector('button');
        expect(button?.textContent).toBe('Open settings');
        expect(button?.getAttribute('aria-label')).toBe('Open settings');
        expect(notice).toBeTruthy();
    });

    it('clicking the button opens the plugin settings tab', () => {
        const ctx = makePlugin();
        noticeWithSettingsLink(ctx.plugin, 'Semantic search is not enabled.');
        const fragment = noticeInstances[0].message as DocumentFragment;
        const button = fragment.querySelector('button') as HTMLButtonElement;
        button.click();
        expect(ctx.open).toHaveBeenCalledTimes(1);
        expect(ctx.openTabById).toHaveBeenCalledWith('ai-organiser');
    });

    it('clicking the button hides the Notice', () => {
        const ctx = makePlugin();
        noticeWithSettingsLink(ctx.plugin, 'msg');
        const fragment = noticeInstances[0].message as DocumentFragment;
        (fragment.querySelector('button') as HTMLButtonElement).click();
        expect(noticeInstances[0].hide).toHaveBeenCalledTimes(1);
    });

    it('uses 8000ms timeout on desktop by default', () => {
        const ctx = makePlugin();
        noticeWithSettingsLink(ctx.plugin, 'msg');
        expect(noticeInstances[0].timeout).toBe(8000);
    });

    it('honours a caller-supplied timeout override', () => {
        const ctx = makePlugin();
        noticeWithSettingsLink(ctx.plugin, 'msg', 3000);
        expect(noticeInstances[0].timeout).toBe(3000);
    });

    it('falls back gracefully when app.setting is missing', () => {
        const ctx = makePlugin({ settingApiPresent: false });
        // Must NOT throw — Notice still surfaces, click is a no-op for navigation
        noticeWithSettingsLink(ctx.plugin, 'msg');
        const fragment = noticeInstances[0].message as DocumentFragment;
        const button = fragment.querySelector('button') as HTMLButtonElement;
        expect(() => button.click()).not.toThrow();
        expect(noticeInstances[0].hide).toHaveBeenCalledTimes(1);
    });
});
