import { describe, it, expect } from 'vitest';
import { buildSlideRuntimeCode } from '../src/services/chat/slideRuntime';

const TEST_NONCE = 'abc123def456';

describe('buildSlideRuntimeCode', () => {
    it('returns a string containing the nonce', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain(TEST_NONCE);
    });

    it('returns raw JS without script tags', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).not.toContain('<script');
        expect(code).not.toContain('</script');
    });

    it('is wrapped in an IIFE', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toMatch(/^\(function\(\)/);
        expect(code).toMatch(/\}\)\(\);$/);
    });

    it('contains ArrowLeft keyboard handler', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("'ArrowLeft'");
    });

    it('contains ArrowRight keyboard handler', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("'ArrowRight'");
    });

    it('contains Home keyboard handler', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("'Home'");
    });

    it('contains End keyboard handler', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("'End'");
    });

    it('contains N key handler for notes toggle', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("'n'");
        expect(code).toContain("'N'");
    });

    it('sends slideChanged message via postMessage', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("action: 'slideChanged'");
        expect(code).toContain('parent.postMessage');
    });

    it('sends ready message on init', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("action: 'ready'");
    });

    it('listens for goToSlide messages from parent', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("data.action === 'goToSlide'");
    });

    it('listens for toggleNotes messages from parent', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("data.action === 'toggleNotes'");
    });

    it('uses slide selector fallback chain', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        // Primary: section[data-slide], then .slide class, then bare section
        expect(code).toContain("section[data-slide]");
        expect(code).toContain('.slide');
        expect(code).toContain("'section'");
    });

    it('toggles speaker-notes visibility', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain('speaker-notes');
        expect(code).toContain('notesVisible');
    });

    it('validates nonce on incoming messages', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain('data.nonce !== NONCE');
    });

    it('includes slideCount in slideChanged payload', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain('slideCount');
    });

    it('uses unique nonce per invocation', () => {
        const code1 = buildSlideRuntimeCode('nonce_aaa');
        const code2 = buildSlideRuntimeCode('nonce_bbb');
        expect(code1).toContain('nonce_aaa');
        expect(code1).not.toContain('nonce_bbb');
        expect(code2).toContain('nonce_bbb');
        expect(code2).not.toContain('nonce_aaa');
    });

    // ── Element selection (slide-authoring-editing plan) ────────────────────

    it('emits an elementSelected click handler', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("action: 'elementSelected'");
    });

    it('walks up to find a [data-element] ancestor', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain('data-element');
        // The walk uses parentNode, not querySelector — guard against
        // someone replacing it with a top-down search that would match
        // sibling elements.
        expect(code).toContain('parentNode');
    });

    it('falls back to slide-level scope when click misses an element', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        // The slide-level branch emits kind: 'slide' with just slideIndex
        expect(code).toContain("kind: 'slide'");
    });

    it('emits an element-level branch with elementPath + elementKind', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        expect(code).toContain("kind: 'element'");
        expect(code).toContain('elementPath');
        expect(code).toContain('elementKind');
    });

    it('toggles a hover class via mouseover, not inline style', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        // CSP-safe — class-list mutation only
        expect(code).toContain('pres-slide-element-hover');
        expect(code).toContain('mouseover');
        expect(code).toContain('classList.add');
        expect(code).toContain('classList.remove');
        // No inline style assignment for the hover effect
        expect(code).not.toContain('style.outline');
    });

    it('classifies element kinds via path-suffix regex', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        // Spot-check that the regex predicates for the most common kinds
        // are emitted (full classification is path-driven by the parent
        // handler — this guards against accidental removal).
        expect(code).toContain('list-item');
        expect(code).toContain('heading');
        expect(code).toContain('image');
        expect(code).toContain('table');
    });

    it('ignores clicks on speaker-notes (toggle key handles those)', () => {
        const code = buildSlideRuntimeCode(TEST_NONCE);
        // The click handler explicitly skips when target.closest('.speaker-notes')
        // matches — guards against the user clicking note text and getting an
        // edit scope they didn't intend.
        expect(code).toMatch(/closest\([^)]*speaker-notes/);
    });
});
