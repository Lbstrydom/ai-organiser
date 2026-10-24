/**
 * Sentinel collision: a persona / focus / context string that contains the literal
 * placeholder must not intercept the insertion of the document text.
 */
import { describe, it, expect } from 'vitest';
import {
    buildSummaryPrompt,
    buildSummaryPromptParts,
    buildChunkCombinePrompt,
    insertContentIntoPrompt,
    insertSectionsIntoPrompt,
} from '../src/services/prompts/summaryPrompts';
import { joinPromptParts, fillTrailingSlot } from '../src/services/prompts/promptParts';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from '../src/services/prompts/triagePrompts';
import { buildTranslatePrompt, insertContentIntoTranslatePrompt } from '../src/services/prompts/translatePrompts';
import { buildStructuredSummaryPrompt, insertContentIntoStructuredPrompt } from '../src/services/prompts/structuredPrompts';

const CP = 'CONTENT_PLACEHOLDER';
const SP = 'SECTIONS_PLACEHOLDER';
const DOC = 'The document body.';

/** The old behaviour: first occurrence wins. Ordinary input must still match it byte for byte. */
const oldInsert = (tpl: string, sentinel: string, text: string) => tpl.replace(sentinel, () => text);

describe('fillTrailingSlot', () => {
    it('fills the last occurrence only', () => {
        expect(fillTrailingSlot(`a ${CP} b ${CP} c`, CP, 'X')).toBe(`a ${CP} b X c`);
    });
    it('returns the template unchanged when the sentinel is absent', () => {
        expect(fillTrailingSlot('nothing here', CP, 'X')).toBe('nothing here');
    });
    it('inserts literally ($ tokens are not expanded)', () => {
        expect(fillTrailingSlot(`a ${CP}`, CP, "$& $1 $$ $` $'")).toBe("a $& $1 $$ $` $'");
    });
});

describe('summary prompts with a sentinel in persona / focus', () => {
    const persona = `You are a ${CP} expert.`;
    const focus = `focus on ${CP} and ${SP}`;

    it('persona prompt: content lands in the document slot, planted text survives', () => {
        const parts = buildSummaryPromptParts({ length: 'brief', personaPrompt: persona, userContext: focus });
        const joined = joinPromptParts(parts.stablePrefix, parts.prompt);
        const filled = insertContentIntoPrompt(joined, DOC);
        expect(filled).toContain(`You are a ${CP} expert.`);
        expect(filled).toContain(`focus on ${CP} and ${SP}`);
        expect(filled.endsWith(`<document_content>\n${DOC}\n</document_content>`)).toBe(true);
        expect(filled.split(DOC).length - 1).toBe(1);
    });

    it('persona prompt per-chunk path (parts.prompt only)', () => {
        const parts = buildSummaryPromptParts({ length: 'brief', personaPrompt: persona, userContext: focus });
        const filled = insertContentIntoPrompt(parts.prompt, DOC);
        expect(filled).toContain(`focus on ${CP} and ${SP}`);
        expect(filled.endsWith(`<document_content>\n${DOC}\n</document_content>`)).toBe(true);
    });

    it('basic prompt (no persona) with sentinel in focus', () => {
        const filled = insertContentIntoPrompt(buildSummaryPrompt({ length: 'standard', userContext: focus }), DOC);
        expect(filled).toContain(`focus on ${CP} and ${SP}`);
        expect(filled.endsWith(`<document_content>\n${DOC}\n</document_content>`)).toBe(true);
    });

    it('combine prompt (persona and basic) with sentinel in persona', () => {
        for (const personaPrompt of [persona, undefined]) {
            const tpl = buildChunkCombinePrompt({ length: 'standard', personaPrompt, userContext: focus });
            const filled = insertSectionsIntoPrompt(tpl, ['one', 'two']);
            if (personaPrompt) expect(filled).toContain(`You are a ${CP} expert.`);
            expect(filled).toContain('[Section 1/2]\none\n\n[Section 2/2]\ntwo\n</section_summaries>');
        }
        const tpl = buildChunkCombinePrompt({ length: 'standard', personaPrompt: `p ${SP} q` });
        const filled = insertSectionsIntoPrompt(tpl, ['one']);
        expect(filled).toContain(`p ${SP} q`);
        expect(filled.endsWith('[Section 1/1]\none\n</section_summaries>')).toBe(true);
    });
});

describe('other templates with a sentinel in a free field', () => {
    it('triage: sentinel in language', () => {
        for (const contentType of ['web', 'newsletter'] as const) {
            const tpl = buildTriagePrompt({ language: `x ${CP} y`, contentType });
            const filled = insertContentIntoTriagePrompt(tpl, DOC);
            expect(filled).toContain(`Write in x ${CP} y`);
            expect(filled).toContain(`<document_content>\n${DOC}\n</document_content>`);
        }
    });

    it('translate: sentinel in the source title', () => {
        const tpl = buildTranslatePrompt({ targetLanguage: 'French', sourceType: 'note', sourceTitle: `A ${CP} B` });
        const filled = insertContentIntoTranslatePrompt(tpl, DOC);
        expect(filled).toContain(`titled "A ${CP} B"`);
        expect(filled.endsWith(`<content_to_translate>\n${DOC}\n</content_to_translate>`)).toBe(true);
    });

    it('structured: sentinel-like text in persona and focus', () => {
        const tpl = buildStructuredSummaryPrompt({ personaPrompt: 'p {{CONTENT}} q', userContext: 'f {{CONTENT}} g' });
        const filled = insertContentIntoStructuredPrompt(tpl, DOC);
        expect(filled).toContain('p {{CONTENT}} q');
        expect(filled).toContain('f {{CONTENT}} g');
        expect(filled.endsWith(`<content>\n${DOC}\n</content>`)).toBe(true);
    });
});

describe('byte identity for ordinary input', () => {
    it('every insert function equals the old first-occurrence replace', () => {
        const summary = buildSummaryPrompt({ length: 'detailed', language: 'German', personaPrompt: 'Be terse.', userContext: 'dates' });
        expect(insertContentIntoPrompt(summary, DOC)).toBe(oldInsert(summary, CP, DOC));
        const basic = buildSummaryPrompt({ length: 'brief' });
        expect(insertContentIntoPrompt(basic, DOC)).toBe(oldInsert(basic, CP, DOC));
        const combine = buildChunkCombinePrompt({ length: 'standard', personaPrompt: 'Be terse.' });
        expect(insertSectionsIntoPrompt(combine, ['a', 'b'])).toBe(
            oldInsert(combine, SP, '[Section 1/2]\na\n\n[Section 2/2]\nb'),
        );
        const triage = buildTriagePrompt({ language: 'English', contentType: 'pdf' });
        expect(insertContentIntoTriagePrompt(triage, DOC)).toBe(oldInsert(triage, CP, DOC));
        const translate = buildTranslatePrompt({ targetLanguage: 'French' });
        expect(insertContentIntoTranslatePrompt(translate, DOC)).toBe(oldInsert(translate, CP, DOC));
        const structured = buildStructuredSummaryPrompt({ personaPrompt: 'p', userContext: 'f' });
        expect(insertContentIntoStructuredPrompt(structured, DOC)).toBe(oldInsert(structured, '{{CONTENT}}', DOC));
    });
});
