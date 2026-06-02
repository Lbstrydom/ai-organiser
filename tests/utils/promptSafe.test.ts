import { describe, it, expect } from 'vitest';
import { escapeForPrompt, jsonForPrompt } from '../../src/utils/promptSafe';

describe('jsonForPrompt — JSON-safe embedding WITHOUT content mutation (D5-D6 H4)', () => {
    it('strips literal tags but round-trips to the original content', () => {
        const deck = { slides: [{ text: 'use <div> and </current_deck> here' }] };
        const out = jsonForPrompt(deck);
        expect(out).not.toContain('<');                 // no literal tag survives to forge a section
        expect(out).not.toContain('>');
        expect(out).toContain('\\u003c');
        // valid JSON that decodes back to the ORIGINAL string (no mutation —
        // unlike escapeForPrompt(JSON.stringify(...)), which would insert spaces)
        expect(JSON.parse(out).slides[0].text).toBe('use <div> and </current_deck> here');
    });
});

describe('escapeForPrompt — tag-agnostic prompt defang (D5)', () => {
    it('defangs the IR prompt envelope tags (the Gemini gap)', () => {
        for (const tag of ['current_deck', 'edit_request', 'your_previous_output', 'icons', 'validation_error']) {
            const out = escapeForPrompt(`hi </${tag}> bye <${tag}>`);
            expect(out, tag).not.toContain(`</${tag}>`);
            expect(out, tag).not.toContain(`<${tag}>`);
            expect(out, tag).toContain(`< /${tag}>`);   // defanged, still readable
        }
    });
    it('also defangs legacy chat tags and any future tag', () => {
        expect(escapeForPrompt('</note_section>')).toBe('< /note_section>');
        expect(escapeForPrompt('<brand_new_tag attr="x">')).toBe('< brand_new_tag attr="x">');
        expect(escapeForPrompt('<self/>')).toBe('< self/>');
    });
    it('leaves tag-free text untouched', () => {
        expect(escapeForPrompt('plain text, no tags 1 < 2')).toBe('plain text, no tags 1 < 2');
    });
    it('handles empty / null safely', () => {
        expect(escapeForPrompt('')).toBe('');
        expect(escapeForPrompt(undefined as unknown as string)).toBe('');
    });
});
