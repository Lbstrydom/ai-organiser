import { describe, it, expect, vi } from 'vitest';
import { getTruncationOptions, TruncationTranslations } from '../../src/ui/utils/truncation';
import { TruncationChoice } from '../../src/core/constants';

/**
 * Unit Tests for Truncation Controls
 * 
 * Note: These tests focus on the pure logic (getTruncationOptions)
 * Component DOM tests (createTruncationDropdown, etc.) are tested via integration
 * in MinutesCreationModal.test.ts and manual testing since they require jsdom
 */

describe('Truncation Controls - Pure Logic', () => {

    describe('getTruncationOptions() - Core Logic', () => {
        it('should return default options when no translations provided', () => {
            const options = getTruncationOptions();
            
            expect(options).toHaveProperty('truncate');
            expect(options).toHaveProperty('full');
            expect(options).toHaveProperty('skip');
            expect(options.truncate.label).toBe('Truncate');
            expect(options.full.label).toBe('Use Full');
            expect(options.skip.label).toBe('Exclude');
        });

        it('should use provided translation strings', () => {
            const translations: TruncationTranslations = {
                truncateOption: 'Custom Truncate',
                truncateTooltip: 'Custom tooltip',
                useFullOption: 'Custom Full',
                skipOption: 'Custom Skip'
            };
            const options = getTruncationOptions(translations);
            
            expect(options.truncate.label).toBe('Custom Truncate');
            expect(options.truncate.tooltip).toBe('Custom tooltip');
            expect(options.full.label).toBe('Custom Full');
            expect(options.skip.label).toBe('Custom Skip');
        });

        it('should use defaults for missing translation strings', () => {
            const partialTranslations: TruncationTranslations = {
                truncateOption: 'Custom'
            };
            const options = getTruncationOptions(partialTranslations);
            
            expect(options.truncate.label).toBe('Custom');
            expect(options.full.label).toBe('Use Full'); // Default
            expect(options.truncate.tooltip).toContain('50k'); // Default
        });

        it('should handle undefined translations gracefully', () => {
            const options = getTruncationOptions(undefined);
            
            expect(options.truncate.label).toBe('Truncate');
            expect(options.full.tooltip).toContain('entire document');
        });

        it('should return all three truncation choices', () => {
            const options = getTruncationOptions();
            const choices = Object.keys(options) as TruncationChoice[];
            
            expect(choices).toContain('truncate');
            expect(choices).toContain('full');
            expect(choices).toContain('skip');
            expect(choices.length).toBe(3);
        });

        it('should have label and tooltip for each choice', () => {
            const options = getTruncationOptions();
            
            for (const choice of ['truncate', 'full', 'skip'] as TruncationChoice[]) {
                expect(options[choice]).toHaveProperty('label');
                expect(options[choice]).toHaveProperty('tooltip');
                expect(typeof options[choice].label).toBe('string');
                expect(typeof options[choice].tooltip).toBe('string');
                expect(options[choice].label.length).toBeGreaterThan(0);
                expect(options[choice].tooltip.length).toBeGreaterThan(0);
            }
        });

        it('should use nullish coalescing for translation fallback', () => {
            // Test that undefined and null both use defaults
            const options1 = getTruncationOptions(undefined);
            const options2 = getTruncationOptions({});
            
            expect(options1.truncate.label).toBe(options2.truncate.label);
            expect(options1.full.tooltip).toBe(options2.full.tooltip);
        });

        it('should have tooltips that mention token limits and behavior', () => {
            const options = getTruncationOptions();
            
            expect(options.truncate.tooltip).toContain('50k');
            expect(options.full.tooltip).toContain('entire document');
            expect(options.skip.tooltip).toContain('Exclude');
        });
    });

});

/**
 * Component DOM Tests (createTruncationDropdown, createTruncationWarning, createBulkTruncationControls)
 * 
 * These functions are tested via:
 * 1. Integration tests in MinutesCreationModal when modal is opened
 * 2. Manual testing checklist in docs/usertest.md
 * 
 * DOM tests would require jsdom environment and Obsidian API mocks.
 * Since the functions use Obsidian's createEl/createDiv/setTooltip,
 * integration testing via the modal is the practical approach.
 */
