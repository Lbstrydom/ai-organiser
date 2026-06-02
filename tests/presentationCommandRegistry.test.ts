/**
 * Unit tests for the presentation command registry — the explicit-registration
 * replacement for the old static `activeInstance` (TD-SSR-02 Phase 0).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    registerPresentationTarget,
    unregisterPresentationTarget,
    getActivePresentationTarget,
    _resetPresentationRegistry,
    type PresentationCommandTarget,
} from '../src/ui/chat/presentation/presentationCommandRegistry';

function makeTarget(html: string | null): PresentationCommandTarget {
    return { getDeckHtml: () => html, selectSlideFromCommand: () => {} };
}

describe('presentationCommandRegistry', () => {
    beforeEach(() => _resetPresentationRegistry());

    it('returns null when no handler is registered', () => {
        expect(getActivePresentationTarget()).toBeNull();
    });

    it('returns the registered handler', () => {
        const a = makeTarget('a');
        registerPresentationTarget(a);
        expect(getActivePresentationTarget()).toBe(a);
    });

    it('most-recently-activated handler wins with multiple live', () => {
        const a = makeTarget('a');
        const b = makeTarget('b');
        registerPresentationTarget(a);
        registerPresentationTarget(b);
        expect(getActivePresentationTarget()).toBe(b);
    });

    it('re-registering an existing handler re-activates it', () => {
        const a = makeTarget('a');
        const b = makeTarget('b');
        registerPresentationTarget(a);
        registerPresentationTarget(b);
        registerPresentationTarget(a);   // a regains focus
        expect(getActivePresentationTarget()).toBe(a);
    });

    it('unregistering the active handler falls back to another live one (no dangling pointer)', () => {
        const a = makeTarget('a');
        const b = makeTarget('b');
        registerPresentationTarget(a);
        registerPresentationTarget(b);   // b active
        unregisterPresentationTarget(b);
        expect(getActivePresentationTarget()).toBe(a);   // not null, not b
    });

    it('unregistering the last handler returns null', () => {
        const a = makeTarget('a');
        registerPresentationTarget(a);
        unregisterPresentationTarget(a);
        expect(getActivePresentationTarget()).toBeNull();
    });

    it('unregistering a non-active handler leaves the active one intact', () => {
        const a = makeTarget('a');
        const b = makeTarget('b');
        registerPresentationTarget(a);
        registerPresentationTarget(b);   // b active
        unregisterPresentationTarget(a);
        expect(getActivePresentationTarget()).toBe(b);
    });
});
