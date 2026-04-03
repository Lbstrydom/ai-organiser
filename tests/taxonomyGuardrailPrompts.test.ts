/**
 * Taxonomy Guardrail Prompt Invariant Tests
 *
 * Tests buildTaxonomyRepairPrompt() for structural invariants:
 * - Prompt contains the candidate tag
 * - Prompt contains the available options
 * - Prompt requests exact match or "NOVEL"
 */

import { buildTaxonomyRepairPrompt } from '../src/services/prompts/tagPrompts';

describe('buildTaxonomyRepairPrompt', () => {
    const options = ['Technology', 'Science', 'Arts'];

    it('contains the candidate tag in the prompt', () => {
        const prompt = buildTaxonomyRepairPrompt('tech', 'theme', options);
        expect(prompt).toContain('tech');
    });

    it('contains all available options', () => {
        const prompt = buildTaxonomyRepairPrompt('tech', 'theme', options);
        for (const option of options) {
            expect(prompt).toContain(option);
        }
    });

    it('requests exact match or NOVEL response', () => {
        const prompt = buildTaxonomyRepairPrompt('tech', 'theme', options);
        expect(prompt).toContain('NOVEL');
        expect(prompt).toContain('exact');
    });

    it('includes the slot type in context', () => {
        const themePrompt = buildTaxonomyRepairPrompt('tech', 'theme', options);
        expect(themePrompt).toContain('theme');

        const disciplinePrompt = buildTaxonomyRepairPrompt('cs', 'discipline', options);
        expect(disciplinePrompt).toContain('discipline');
    });

    it('uses XML-style structure', () => {
        const prompt = buildTaxonomyRepairPrompt('tech', 'theme', options);
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('</task>');
        expect(prompt).toContain('<available_options>');
        expect(prompt).toContain('</available_options>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('</output_format>');
    });
});
