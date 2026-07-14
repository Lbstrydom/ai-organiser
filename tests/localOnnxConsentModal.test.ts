/**
 * LocalOnnxConsentModal tests — open / accept / decline / ESC.
 *
 * Mirrors tests/diarizationPrivacyModal.test.ts's established pattern (the
 * mocked Obsidian Modal does NOT auto-fire onOpen/onClose; tests invoke
 * them explicitly).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { LocalOnnxConsentModal } from '../src/ui/modals/LocalOnnxConsentModal';
import { en } from '../src/i18n/en';
import type { Translations } from '../src/i18n/types';

function makeApp(): App {
    return new App();
}

const t: Translations = en;

type MockEl = { _dispatch(event: string): void };

function dispatchClick(el: unknown): void {
    (el as MockEl)._dispatch('click');
}

describe('LocalOnnxConsentModal', () => {
    let app: App;

    beforeEach(() => {
        app = makeApp();
    });

    it('fires callback(true) when accept button clicked', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-accept');
        expect(accept).not.toBeNull();
        dispatchClick(accept);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(true);
    });

    it('fires callback(false) when decline button clicked', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        const decline = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-decline');
        expect(decline).not.toBeNull();
        dispatchClick(decline);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('fires callback(false) when modal closed without a button click (ESC-as-decline)', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();
        modal.onClose();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('does NOT double-fire when accept is clicked then the modal closes', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-accept');
        dispatchClick(accept);
        modal.onClose();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(true);
    });

    it('does NOT double-fire when decline is clicked then the modal closes', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        const decline = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-decline');
        dispatchClick(decline);
        modal.onClose();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(false);
    });

    it('renders accept/decline buttons with expected copy', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        const accept = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-accept');
        const decline = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-decline');
        expect((accept as any)?.textContent).toContain('Enable local embeddings');
        expect((decline as any)?.textContent).toContain("Don't enable");
    });

    it('renders the plain-language risk disclosure bullets', () => {
        const cb = vi.fn();
        const modal = new LocalOnnxConsentModal(app, t, cb);
        modal.onOpen();

        // The mock DOM's querySelectorAll is a stub (always []) — query the
        // list container (querySelector works) and inspect its children.
        const bulletList = modal.contentEl.querySelector('.ai-organiser-local-onnx-consent-bullets');
        expect(bulletList).not.toBeNull();
        const children = (bulletList as any).children as unknown[];
        expect(children.length).toBe(3);
        const allText = JSON.stringify(bulletList);
        expect(allText).toMatch(/critical-severity|critical/i);
        expect(allText).toMatch(/optional/i);
    });
});
