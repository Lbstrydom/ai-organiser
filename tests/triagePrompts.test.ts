/**
 * Triage Prompts Tests
 *
 * Tests prompt builder invariants for the Web Reader triage prompt.
 * Follows the same pattern as promptInvariants.test.ts.
 */

import {
    buildTriagePrompt,
    insertContentIntoTriagePrompt
} from '../src/services/prompts/triagePrompts';

describe('Triage Prompts - Invariants', () => {
    describe('buildTriagePrompt', () => {
        it('should include task XML tags', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('<task>');
            expect(prompt).toContain('</task>');
        });

        it('should include requirements and output_format XML tags', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('<requirements>');
            expect(prompt).toContain('</requirements>');
            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('</output_format>');
        });

        it('should include specified language when provided', () => {
            const prompt = buildTriagePrompt({ language: 'Spanish' });
            expect(prompt).toContain('Spanish');
        });

        it('should include default language instruction when no language specified', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('same language as the source content');
        });

        it('should mention sentence count guidance (3 and 6)', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('3');
            expect(prompt).toContain('6');
            expect(prompt.toLowerCase()).toContain('sentence');
        });

        it('should mention paragraph format', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt.toLowerCase()).toContain('paragraph');
        });

        it('should include content placeholder in document_content section', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('<document_content>');
            expect(prompt).toContain('CONTENT_PLACEHOLDER');
            expect(prompt).toContain('</document_content>');
        });

        it('should include critical_instructions for prompt injection prevention', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).toContain('<critical_instructions>');
            expect(prompt).toContain('UNTRUSTED');
        });
    });

    describe('contentType parameter', () => {
        it('should include type hint for web content', () => {
            const prompt = buildTriagePrompt({ contentType: 'web' });
            expect(prompt).toContain('a web article');
        });

        it('should include type hint for PDF content', () => {
            const prompt = buildTriagePrompt({ contentType: 'pdf' });
            expect(prompt).toContain('a PDF document');
        });

        it('should include type hint for YouTube content', () => {
            const prompt = buildTriagePrompt({ contentType: 'youtube' });
            expect(prompt).toContain('a YouTube video transcript');
        });

        it('should include type hint for document content', () => {
            const prompt = buildTriagePrompt({ contentType: 'document' });
            expect(prompt).toContain('an Office document');
        });

        it('should include type hint for audio content', () => {
            const prompt = buildTriagePrompt({ contentType: 'audio' });
            expect(prompt).toContain('an audio transcription');
        });

        it('should not include type hint when contentType is omitted', () => {
            const prompt = buildTriagePrompt({});
            expect(prompt).not.toContain('adapt your focus accordingly');
        });

        it('should include "adapt your focus" when contentType is set', () => {
            const prompt = buildTriagePrompt({ contentType: 'pdf' });
            expect(prompt).toContain('adapt your focus accordingly');
        });
    });

    describe('insertContentIntoTriagePrompt', () => {
        it('should replace placeholder with provided content', () => {
            const prompt = buildTriagePrompt({});
            const result = insertContentIntoTriagePrompt(prompt, 'Article text here');
            expect(result).toContain('Article text here');
        });

        it('should not contain raw placeholder after insertion', () => {
            const prompt = buildTriagePrompt({});
            const result = insertContentIntoTriagePrompt(prompt, 'Some content');
            expect(result).not.toContain('CONTENT_PLACEHOLDER');
        });
    });
});
