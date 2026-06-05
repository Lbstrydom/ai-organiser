import { describe, it, expect } from 'vitest';
import { buildEvidenceCatalog } from '../src/services/presentationIr/evidenceCatalog';

describe('buildEvidenceCatalog', () => {
    it('splits sources into paragraph spans with short stable ids', () => {
        const cat = buildEvidenceCatalog([{ ref: 'q3.md', content: 'Intro para.\n\nEMEA was 60% of growth.' }]);
        expect(cat.map((s) => s.id)).toEqual(['e1', 'e2']);
        expect(cat.every((s) => s.source_ref === 'q3.md')).toBe(true);
    });

    it('ranks number-bearing paragraphs ahead of prose', () => {
        const cat = buildEvidenceCatalog([{ ref: 's', content: 'Just narrative prose here.\n\nRevenue grew 24% YoY.' }]);
        expect(cat[0].text).toContain('24%'); // number-bearing first
        expect(cat[1].text).toContain('narrative');
    });

    it('keeps document order within the same rank (stable sort)', () => {
        const cat = buildEvidenceCatalog([{ ref: 's', content: 'A is 1.\n\nB is 2.\n\nC is 3.' }]);
        expect(cat.map((s) => s.text)).toEqual(['A is 1.', 'B is 2.', 'C is 3.']);
    });

    it('span text is a verbatim slice — never fabricated', () => {
        const cat = buildEvidenceCatalog([{ ref: 's', content: 'EMEA was 60% of Q3 growth.' }]);
        expect('EMEA was 60% of Q3 growth.').toContain(cat[0].text);
    });

    it('respects the span count cap', () => {
        const content = Array.from({ length: 100 }, (_, i) => `Item ${i} value ${i}`).join('\n\n');
        const cat = buildEvidenceCatalog([{ ref: 's', content }], { maxSpans: 5 });
        expect(cat).toHaveLength(5);
    });

    it('respects the total char budget (keeps at least one span)', () => {
        const content = Array.from({ length: 50 }, (_, i) => `Long paragraph number ${i} with some text`).join('\n\n');
        const cat = buildEvidenceCatalog([{ ref: 's', content }], { maxTotalChars: 100 });
        expect(cat.length).toBeGreaterThan(0);
        expect(cat.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(100 + 40);
    });

    it('truncates an over-long paragraph to maxSpanChars', () => {
        const cat = buildEvidenceCatalog([{ ref: 's', content: 'x'.repeat(2000) }], { maxSpanChars: 100 });
        expect(cat[0].text.length).toBeLessThanOrEqual(100);
    });

    it('ignores malformed sources without throwing', () => {
        const cat = buildEvidenceCatalog([{ ref: 'a', content: '' }, { ref: 'b', content: 'Real 9 content' }]);
        expect(cat).toHaveLength(1);
        expect(cat[0].source_ref).toBe('b');
    });
});
