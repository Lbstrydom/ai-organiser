/**
 * Run-lock recovery (presentation "dead toolbar" fix).
 *
 * `run.abort()` signals the AbortController but does NOT clear `locked` — only an
 * op's own finally → `run.end()` does. A wedged run therefore stayed locked
 * forever, disabling every deck action (`hasDeck && !locked`) AND leaving
 * Clear/Discard unable to recover. `cancelActiveOperation` (used by `onClear`)
 * must force-release. These tests pin that contract.
 */
import { describe, it, expect } from 'vitest';

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { en } from '../src/i18n/en';

function makeHandler(): PresentationModeHandler {
    const h = new PresentationModeHandler();
    Object.assign((h as unknown as { deck: Record<string, unknown> }).deck, {
        html: '<deck>',
        deckIr: coffeeDeckIr,
        phase: 'preview-ready',
    });
    return h;
}

function run(h: PresentationModeHandler) {
    return (h as unknown as {
        run: { lock: () => void; isLocked: () => boolean; begin: (u: (m: string) => void, t: unknown) => unknown };
    }).run;
}

function deckHtml(h: PresentationModeHandler): string | null {
    return (h as unknown as { deck: { html: string | null } }).deck.html;
}

describe('presentation run-lock recovery', () => {
    it('onClear releases a lock taken via lock() (the wedged-export case) and clears the deck', () => {
        const h = makeHandler();
        run(h).lock(); // simulate an op that locked and never released
        expect(run(h).isLocked()).toBe(true);

        h.onClear();

        expect(run(h).isLocked()).toBe(false);
        expect(deckHtml(h)).toBeNull();
    });

    it('onClear releases a lock taken via begin() (the wedged-generation case)', () => {
        const h = makeHandler();
        run(h).begin(() => { /* thinking sink */ }, en.modals.unifiedChat); // locks + mints abort controller
        expect(run(h).isLocked()).toBe(true);

        h.onClear();

        expect(run(h).isLocked()).toBe(false);
    });

    it('a wedged lock is what disabled Discard — onClear re-enables it for the next deck', () => {
        const h = makeHandler();
        run(h).lock();
        // While locked, Discard (`hasDeck && !locked`) is disabled — the not-allowed cursor.
        expect(h.getActionDescriptors(en).find((a) => a.id === 'discard')?.isEnabled).toBe(false);

        h.onClear(); // force-releases the lock (and clears the deck)
        expect(run(h).isLocked()).toBe(false);

        // A fresh deck (as a new generation would set) is now actionable again —
        // proving the lock, not the deck, was the blocker.
        Object.assign((h as unknown as { deck: Record<string, unknown> }).deck, { html: '<deck2>' });
        expect(h.getActionDescriptors(en).find((a) => a.id === 'discard')?.isEnabled).toBe(true);
    });
});
