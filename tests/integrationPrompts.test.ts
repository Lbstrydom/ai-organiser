/**
 * Tests for Integration Prompt Helpers
 */

import { getPlacementInstructions, getFormatInstructions, getDetailInstructions, buildPdfExtractionPrompt } from '../src/services/prompts/integrationPrompts';
import { buildIntegrationPrompt } from '../src/commands/integrationCommands';

describe('Integration Prompt Helpers', () => {
    describe('getPlacementInstructions', () => {
        it('cursor placement should produce self-contained instructions without rewrite', () => {
            const result = getPlacementInstructions('cursor');
            expect(result).toContain('self-contained');
            expect(result.toLowerCase()).not.toContain('rewrite');
        });

        it('append placement should not reference existing content', () => {
            const result = getPlacementInstructions('append');
            expect(result).toContain('self-contained');
            expect(result.toLowerCase()).not.toContain('rewrite');
        });

        it('callout placement should use callout syntax', () => {
            const result = getPlacementInstructions('callout');
            expect(result).toContain('> [!info]');
            expect(result).toContain('Do NOT modify existing text');
        });

        it('merge placement should rewrite and integrate', () => {
            const result = getPlacementInstructions('merge');
            expect(result.toLowerCase()).toContain('rewrite');
            expect(result.toLowerCase()).toContain('integrat');
        });
    });

    describe('getFormatInstructions', () => {
        it('prose should mention paragraphs', () => {
            const result = getFormatInstructions('prose');
            expect(result.toLowerCase()).toContain('prose');
        });

        it('bullets should mention bullet lists', () => {
            const result = getFormatInstructions('bullets');
            expect(result.toLowerCase()).toContain('bullet');
        });

        it('tasks should include checkbox syntax', () => {
            const result = getFormatInstructions('tasks');
            expect(result).toContain('- [ ]');
        });

        it('table should mention markdown tables', () => {
            const result = getFormatInstructions('table');
            expect(result.toLowerCase()).toContain('table');
        });
    });

    describe('getDetailInstructions', () => {
        it('full should include all information', () => {
            const result = getDetailInstructions('full');
            expect(result.toLowerCase()).toContain('all');
        });

        it('concise should mention key points', () => {
            const result = getDetailInstructions('concise');
            expect(result.toLowerCase()).toContain('key points');
        });

        it('summary should distil to core insights', () => {
            const result = getDetailInstructions('summary');
            expect(result.toLowerCase()).toMatch(/distil|core insights/);
        });
    });

    describe('buildIntegrationPrompt', () => {
        const mockPlugin = {
            settings: { summaryLanguage: 'English' }
        } as any;

        it('cursor placement should NOT include main content in prompt', () => {
            const result = buildIntegrationPrompt(
                'Main body text',
                'Pending notes',
                mockPlugin,
                undefined,
                'cursor',
                'prose',
                'full'
            );
            expect(result).not.toContain('<main_content>');
            expect(result).not.toContain('Main body text');
            expect(result).toContain('Pending notes');
        });

        it('append placement should NOT include main content in prompt', () => {
            const result = buildIntegrationPrompt(
                'Main body text',
                'Pending notes',
                mockPlugin,
                undefined,
                'append',
                'prose',
                'full'
            );
            expect(result).not.toContain('<main_content>');
            expect(result).not.toContain('Main body text');
        });

        it('merge placement should include both main and pending content', () => {
            const result = buildIntegrationPrompt(
                'Main body text',
                'Pending notes',
                mockPlugin,
                undefined,
                'merge',
                'prose',
                'full'
            );
            expect(result).toContain('<main_content>');
            expect(result).toContain('Main body text');
            expect(result).toContain('Pending notes');
        });

        it('callout placement should include both main and pending content', () => {
            const result = buildIntegrationPrompt(
                'Main body text',
                'Pending notes',
                mockPlugin,
                undefined,
                'callout',
                'bullets',
                'concise'
            );
            expect(result).toContain('<main_content>');
            expect(result).toContain('Main body text');
        });

        it('should include persona prompt when provided', () => {
            const result = buildIntegrationPrompt(
                '',
                'Pending notes',
                mockPlugin,
                'You are a technical writer.',
                'cursor',
                'prose',
                'full'
            );
            expect(result).toContain('You are a technical writer.');
        });
    });

    describe('buildPdfExtractionPrompt', () => {
        it('should include PDF name in document_name tag', () => {
            const result = buildPdfExtractionPrompt('quarterly-report.pdf');
            expect(result).toContain('<document_name>quarterly-report.pdf</document_name>');
        });

        it('should request full extraction not summarization', () => {
            const result = buildPdfExtractionPrompt('report.pdf');
            expect(result).toContain('Extract ALL text content');
            expect(result).toContain('Do NOT summarize');
            // Should emphasize extraction over summarization
            expect(result).toContain('FULL content');
        });

        it('should include instructions for diagrams and visual content', () => {
            const result = buildPdfExtractionPrompt('presentation.pdf');
            expect(result).toMatch(/diagram|chart|graph|image/i);
        });

        it('should include instructions for tables', () => {
            const result = buildPdfExtractionPrompt('data.pdf');
            expect(result).toContain('markdown table');
        });

        it('should include language instruction when provided', () => {
            const result = buildPdfExtractionPrompt('document.pdf', 'Chinese');
            expect(result).toContain('Respond in Chinese');
        });

        it('should not include language instruction when not provided', () => {
            const result = buildPdfExtractionPrompt('document.pdf');
            expect(result).not.toContain('Respond in');
        });

        it('should request markdown output format', () => {
            const result = buildPdfExtractionPrompt('report.pdf');
            expect(result).toContain('<output_format>');
            expect(result.toLowerCase()).toContain('markdown');
        });
    });
});
