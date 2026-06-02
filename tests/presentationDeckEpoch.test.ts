/**
 * Deck-epoch monotonicity (TD-SSR-02 Phase 1).
 *
 * getLayoutState().deckVersion is the thumbnail-cache key + the layout
 * change-signal. It MUST be monotonic — never `versions.length`, which is
 * capped by MAX_VERSIONS and unchanged by a version restore, both of which
 * would silently serve STALE filmstrip thumbnails.
 */
import { describe, it, expect } from 'vitest';
import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { MAX_VERSIONS } from '../src/services/chat/presentationTypes';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';

// Deck state now lives on the PresentationDeckStore (this.deck); pushVersion is
// a store method, restoreVersion/restoreState stay on the handler.
interface DeckInternals {
    html: string | null;
    activeSlideIndex: number;
    deckIr: unknown;
    versions: unknown[];
    pushVersion: (p: string) => void;
}
interface HandlerInternals {
    restoreVersion: (i: number) => void;
    restoreState: (d: unknown) => boolean;
}

// Cast through `unknown` — the class's private fields make a direct
// intersection collapse to `never`.
const deck = (h: PresentationModeHandler): DeckInternals =>
    (h as unknown as { deck: DeckInternals }).deck;
const handler = (h: PresentationModeHandler): HandlerInternals => h as unknown as HandlerInternals;

function makeHandler(): PresentationModeHandler {
    const h = new PresentationModeHandler();
    const d = deck(h);
    d.html = '<deck>';
    d.deckIr = coffeeDeckIr;
    d.activeSlideIndex = 0;
    return h;
}

const epoch = (h: PresentationModeHandler) => h.getLayoutState().deckVersion;

describe('deck epoch — monotonic mutation counter', () => {
    it('starts at 0', () => {
        expect(epoch(makeHandler())).toBe(0);
    });

    it('increments on every pushVersion', () => {
        const h = makeHandler();
        deck(h).pushVersion('v1');
        expect(epoch(h)).toBe(1);
        deck(h).pushVersion('v2');
        expect(epoch(h)).toBe(2);
    });

    it('keeps increasing past the MAX_VERSIONS cap (length stops growing, epoch does not)', () => {
        const h = makeHandler();
        const pushes = MAX_VERSIONS + 5;
        for (let i = 0; i < pushes; i++) deck(h).pushVersion(`v${i}`);
        // versions array is capped...
        expect(deck(h).versions.length).toBe(MAX_VERSIONS);
        // ...but the epoch counted every push — this is the stale-thumbnail fix.
        expect(epoch(h)).toBe(pushes);
    });

    it('increments on restoreVersion (whole-deck swap that does not change length)', () => {
        const h = makeHandler();
        deck(h).pushVersion('v1');
        deck(h).pushVersion('v2');
        const before = epoch(h);
        handler(h).restoreVersion(0);
        expect(epoch(h)).toBe(before + 1);
    });

    it('increments on restoreState (session reload)', () => {
        const h = makeHandler();
        const before = epoch(h);
        const restored = handler(h).restoreState({
            schemaVersion: 1,
            html: '<restored/>',
            versions: [{ html: '<restored/>', userPrompt: 'r', timestamp: 1, activeSlideIndex: 0 }],
            conversation: [],
            brandEnabled: false,
        });
        expect(restored).toBe(true);
        expect(epoch(h)).toBe(before + 1);
    });
});
