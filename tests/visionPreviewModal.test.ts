/**
 * VisionPreviewModal Tests
 * Tests for buildFullMarkdown (exported utility) and action callback patterns
 */
import { buildFullMarkdown } from '../src/ui/modals/VisionPreviewModal';
import type { DigitiseResult } from '../src/services/visionService';

describe('VisionPreviewModal', () => {
    describe('buildFullMarkdown', () => {
        it('should include extracted text only', () => {
            const result: DigitiseResult = {
                extractedText: 'Hello world',
                rawResponse: 'Hello world'
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).toBe('Hello world');
            expect(markdown).not.toContain('## Diagram');
            expect(markdown).not.toContain('## Uncertainties');
        });

        it('should include diagram section when present', () => {
            const result: DigitiseResult = {
                extractedText: 'Some text',
                diagram: 'graph TD\nA-->B',
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).toContain('Some text');
            expect(markdown).toContain('## Diagram');
            expect(markdown).toContain('```mermaid');
            expect(markdown).toContain('graph TD\nA-->B');
        });

        it('should include uncertainties when present', () => {
            const result: DigitiseResult = {
                extractedText: 'Some text',
                uncertainties: ['Unclear word', 'Blurry section'],
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).toContain('## Uncertainties');
            expect(markdown).toContain('- Unclear word');
            expect(markdown).toContain('- Blurry section');
        });

        it('should include all sections when all present', () => {
            const result: DigitiseResult = {
                extractedText: 'Meeting notes',
                diagram: 'graph LR\nA-->B',
                uncertainties: ['Item 1'],
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).toContain('Meeting notes');
            expect(markdown).toContain('## Diagram');
            expect(markdown).toContain('```mermaid');
            expect(markdown).toContain('## Uncertainties');
            expect(markdown).toContain('- Item 1');
        });

        it('should handle empty result gracefully', () => {
            const result: DigitiseResult = {
                extractedText: '',
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).toBe('');
        });

        it('should not include empty uncertainties array', () => {
            const result: DigitiseResult = {
                extractedText: 'Text',
                uncertainties: [],
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);

            expect(markdown).not.toContain('## Uncertainties');
        });

        it('should separate sections with blank lines', () => {
            const result: DigitiseResult = {
                extractedText: 'Text',
                diagram: 'graph TD\nA-->B',
                uncertainties: ['Unclear'],
                rawResponse: ''
            };

            const markdown = buildFullMarkdown(result);
            const lines = markdown.split('\n');

            // Text, blank, ## Diagram, blank, ```mermaid, ..., ```, blank, ## Uncertainties, blank, - Unclear
            expect(lines[0]).toBe('Text');
            expect(lines[1]).toBe(''); // blank before Diagram
            expect(lines[2]).toBe('## Diagram');
        });
    });
});
