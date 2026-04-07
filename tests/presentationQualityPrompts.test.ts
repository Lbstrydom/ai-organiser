import { describe, it, expect } from 'vitest';
import {
    buildFastScanPrompt,
    buildDeepScanPrompt,
} from '../src/services/prompts/presentationQualityPrompts';

// ── buildFastScanPrompt ────────────────────────────────────────────────────

describe('buildFastScanPrompt', () => {
    const html = '<div class="slide"><h1>Hello</h1></div>';

    it('contains <task> and <output_format> XML tags', () => {
        const prompt = buildFastScanPrompt(html, 5);
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('</task>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('</output_format>');
    });

    it('contains fast scan categories', () => {
        const prompt = buildFastScanPrompt(html, 5);
        for (const cat of ['colour', 'typography', 'overflow', 'density', 'gestalt', 'consistency']) {
            expect(prompt).toContain(cat);
        }
    });

    it('includes the HTML content', () => {
        const prompt = buildFastScanPrompt(html, 5);
        expect(prompt).toContain(html);
    });

    it('includes the slide count', () => {
        const prompt = buildFastScanPrompt(html, 12);
        expect(prompt).toContain('12 slides');
    });

    it('does not contain sampling note when slideCount <= 30', () => {
        const prompt = buildFastScanPrompt(html, 30);
        expect(prompt).not.toContain('<sampling_note>');
    });

    it('contains sampling note when slideCount > 30', () => {
        const prompt = buildFastScanPrompt(html, 40);
        expect(prompt).toContain('<sampling_note>');
        expect(prompt).toContain('40 slides');
    });

    it('contains JSON example in output format section', () => {
        const prompt = buildFastScanPrompt(html, 5);
        expect(prompt).toContain('"findings"');
        expect(prompt).toContain('"slideIndex"');
        expect(prompt).toContain('"severity"');
    });
});

// ── buildDeepScanPrompt ────────────────────────────────────────────────────

describe('buildDeepScanPrompt', () => {
    const html = '<div class="slide"><p>Deep scan test</p></div>';

    it('contains <task> and <output_format> XML tags', () => {
        const prompt = buildDeepScanPrompt(html, 5);
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('</task>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('</output_format>');
    });

    it('contains deep scan categories (different from fast scan)', () => {
        const prompt = buildDeepScanPrompt(html, 5);
        for (const cat of ['spacing', 'contrast', 'alignment', 'visual-balance']) {
            expect(prompt).toContain(cat);
        }
    });

    it('includes the HTML content', () => {
        const prompt = buildDeepScanPrompt(html, 5);
        expect(prompt).toContain(html);
    });

    it('does not contain sampling note when slideCount <= 30', () => {
        const prompt = buildDeepScanPrompt(html, 25);
        expect(prompt).not.toContain('<sampling_note>');
    });

    it('contains sampling note when slideCount > 30', () => {
        const prompt = buildDeepScanPrompt(html, 50);
        expect(prompt).toContain('<sampling_note>');
        expect(prompt).toContain('50 slides');
    });

    it('contains JSON example in output format section', () => {
        const prompt = buildDeepScanPrompt(html, 5);
        expect(prompt).toContain('"findings"');
        expect(prompt).toContain('"category"');
        expect(prompt).toContain('"suggestion"');
    });
});
