/**
 * DiarizationPrivacyModal tests — open / accept / reject / ESC.
 *
 * The mocked Obsidian Modal (tests/mocks/obsidian.ts) does NOT auto-fire
 * onOpen/onClose; tests invoke them explicitly. Listeners on mock elements
 * are stored in `_listeners` and fired via `_dispatch(event)`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { DiarizationPrivacyModal } from '../src/ui/modals/DiarizationPrivacyModal';
import { en } from '../src/i18n/en';
import type { Translations } from '../src/i18n/types';

function makeApp(): App {
    return new App();
}

const t: Translations = en;

// Cast helpers — the mocked elements support `_dispatch` for synthetic events
type MockEl = { _dispatch(event: string): void };

function dispatchClick(el: unknown): void {
    (el as MockEl)._dispatch('click');
}

describe('DiarizationPrivacyModal', () => {
    let app: App;

    beforeEach(() => {
        app = makeApp();
    });

    it('fires callback(true) when accept button clicked', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector(
            '.ai-organiser-diarization-privacy-accept',
        );
        expect(accept).not.toBeNull();
        dispatchClick(accept);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(true);
    });

    it('fires callback(false) when reject button clicked', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();

        const reject = modal.contentEl.querySelector(
            '.ai-organiser-diarization-privacy-reject',
        );
        expect(reject).not.toBeNull();
        dispatchClick(reject);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('fires callback(false) when modal closed without a button click', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();
        modal.onClose();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('does NOT double-fire when accept is clicked then modal closes', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector(
            '.ai-organiser-diarization-privacy-accept',
        );
        dispatchClick(accept);
        modal.onClose();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(true);
    });

    it('renders accept/reject buttons with expected copy', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector('.ai-organiser-diarization-privacy-accept');
        const reject = modal.contentEl.querySelector('.ai-organiser-diarization-privacy-reject');
        expect((accept as any)?.textContent).toContain('Use Deepgram');
        expect((reject as any)?.textContent).toContain("Don't use");
    });

    it('body mentions the mip_opt_out flag explicitly', () => {
        const cb = vi.fn();
        const modal = new DiarizationPrivacyModal(app, t, cb);
        modal.onOpen();

        const body = modal.contentEl.querySelector('.ai-organiser-diarization-privacy-body');
        expect(body).not.toBeNull();
        // The privacyDescription string contains "mip_opt_out=true" — we render that into a <p>.
        const allText = JSON.stringify(body);
        expect(allText).toContain('mip_opt_out');
    });
});
