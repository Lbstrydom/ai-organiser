/**
 * Tests for Integration Prompt Helpers
 */

import { describe, it, expect } from 'vitest';
import { getPlacementInstructions, getFormatInstructions, getDetailInstructions } from '../src/services/prompts/integrationPrompts';

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
});
