/**
 * Digitise Prompts Tests
 */
import { buildDigitisePrompt } from '../src/services/prompts/digitisePrompts';

describe('digitisePrompts', () => {
    describe('buildDigitisePrompt', () => {
        it('should build prompt with auto mode in English', () => {
            const prompt = buildDigitisePrompt('auto', 'default');

            expect(prompt).toContain('<task>');
            expect(prompt).toContain('</task>');
            expect(prompt).toContain('## Extracted Text');
            expect(prompt).toContain('## Diagram');
            expect(prompt).toContain('## Uncertainties');
            // Auto mode: no mode hint injected (VLM determines content type)
            expect(prompt).not.toContain('<context>');
        });

        it('should build prompt with handwriting mode', () => {
            const prompt = buildDigitisePrompt('handwriting', 'default');

            expect(prompt).toContain('handwritten');
            expect(prompt).toContain('cursive');
            expect(prompt).toContain('<context>');
        });

        it('should build prompt with diagram mode', () => {
            const prompt = buildDigitisePrompt('diagram', 'default');

            expect(prompt).toContain('diagram');
            expect(prompt).toContain('flowchart');
            expect(prompt).toContain('Mermaid');
        });

        it('should build prompt with whiteboard mode', () => {
            const prompt = buildDigitisePrompt('whiteboard', 'default');

            expect(prompt).toContain('whiteboard');
            expect(prompt).toContain('photo');
        });

        it('should build prompt with mixed mode', () => {
            const prompt = buildDigitisePrompt('mixed', 'default');

            expect(prompt).toContain('handwritten text and diagrams');
            expect(prompt).toContain('<context>');
        });

        it('should include language instruction for non-default language', () => {
            const prompt = buildDigitisePrompt('auto', 'Chinese');

            expect(prompt).toContain('Chinese');
        });

        it('should include default language in output instruction', () => {
            const prompt = buildDigitisePrompt('auto', 'default');

            // Language is always included — 'default' is passed through
            expect(prompt).toContain('Output language: default');
        });

        it('should include section format requirements', () => {
            const prompt = buildDigitisePrompt('auto', 'default');

            expect(prompt).toContain('## Extracted Text');
            expect(prompt).toContain('## Diagram');
            expect(prompt).toContain('```mermaid');
            expect(prompt).toContain('## Uncertainties');
        });

        it('should include quality guidelines', () => {
            const prompt = buildDigitisePrompt('auto', 'default');

            expect(prompt).toContain('Preserve the logical reading order');
            expect(prompt).toContain('Mermaid');
        });

        it('should include examples section', () => {
            const prompt = buildDigitisePrompt('auto', 'default');

            expect(prompt).toContain('<examples>');
            expect(prompt).toContain('</examples>');
        });

        it('should maintain consistent structure across modes', () => {
            const autoPrompt = buildDigitisePrompt('auto', 'default');
            const handwritingPrompt = buildDigitisePrompt('handwriting', 'default');

            // All prompts should have task, requirements, format, examples
            expect(autoPrompt).toContain('<task>');
            expect(handwritingPrompt).toContain('<task>');
            expect(autoPrompt).toContain('<requirements>');
            expect(handwritingPrompt).toContain('<requirements>');
            expect(autoPrompt).toContain('<output_format>');
            expect(handwritingPrompt).toContain('<output_format>');
        });
    });
});
