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
});
