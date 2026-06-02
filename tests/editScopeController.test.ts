/**
 * EditScopeController (TD-SSR-02 Phase 6).
 *
 * State seam the generation pipeline depends on: selection / editMode /
 * editFlags, the mutation-lock guard on element clicks, and the active-slide
 * callback. render() no-ops while unbound, so the state logic is testable
 * without a DOM / renderEditAccessories.
 */
import { describe, it, expect, vi } from 'vitest';
import { EditScopeController, type EditScopeDeps } from '../src/ui/chat/presentation/editScopeController';

function make(over: Partial<EditScopeDeps> = {}) {
    const onActiveSlide = vi.fn();
    const deps: EditScopeDeps = {
        getOperation: () => 'idle',
        isLocked: () => false,
        onActiveSlide,
        ...over,
    };
    return { c: new EditScopeController(deps), onActiveSlide };
}

describe('EditScopeController', () => {
    it('defaults: no selection, content mode, no web search', () => {
        const { c } = make();
        expect(c.getSelection()).toBeNull();
        expect(c.getEditMode()).toBe('content');
        expect(c.getEditFlags()).toEqual({ webSearch: false, references: [] });
    });

    it('selectFromEvent (slide) sets a slide scope + reports the active slide', () => {
        const { c, onActiveSlide } = make();
        c.selectFromEvent({ kind: 'slide', slideIndex: 3 });
        expect(c.getSelection()).toEqual({ kind: 'slide', slideIndex: 3 });
        expect(onActiveSlide).toHaveBeenCalledWith(3);
    });

    it('selectFromEvent (element) keeps a known elementKind', () => {
        const { c } = make();
        c.selectFromEvent({ kind: 'element', slideIndex: 1, elementPath: 'p0', elementKind: 'table' });
        expect(c.getSelection()).toEqual({ kind: 'element', slideIndex: 1, elementPath: 'p0', elementKind: 'table' });
    });

    it('selectFromEvent (element) drops an unknown elementKind to undefined', () => {
        const { c } = make();
        c.selectFromEvent({ kind: 'element', slideIndex: 1, elementPath: 'p0', elementKind: 'bogus' });
        expect(c.getSelection()).toEqual({ kind: 'element', slideIndex: 1, elementPath: 'p0', elementKind: undefined });
    });

    it('ignores element clicks while locked (mid-apply)', () => {
        const { c, onActiveSlide } = make({ isLocked: () => true });
        c.selectFromEvent({ kind: 'slide', slideIndex: 2 });
        expect(c.getSelection()).toBeNull();
        expect(onActiveSlide).not.toHaveBeenCalled();
    });

    it('setSelection / clear', () => {
        const { c } = make();
        c.setSelection({ kind: 'slide', slideIndex: 0 });
        expect(c.getSelection()).not.toBeNull();
        c.clear();
        expect(c.getSelection()).toBeNull();
    });

    it('reset clears selection + mode + flags', () => {
        const { c } = make();
        c.setSelectionForTesting({ kind: 'slide', slideIndex: 5 });
        c.reset();
        expect(c.getSelection()).toBeNull();
        expect(c.getEditMode()).toBe('content');
        expect(c.getEditFlags()).toEqual({ webSearch: false, references: [] });
    });

    it('render() is a safe no-op before bind / after dispose', () => {
        const { c } = make();
        expect(() => c.render()).not.toThrow();
        c.dispose();
        expect(() => c.render()).not.toThrow();
        expect(c.getSelection()).toBeNull();
    });
});
