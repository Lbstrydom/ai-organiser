import { describe, it, expect } from 'vitest';
import { isRichSlideArray } from '../src/services/pptxExport/richSlideTypes';

describe('isRichSlideArray', () => {
    it('accepts an empty array', () => {
        expect(isRichSlideArray([])).toBe(true);
    });

    it('accepts a well-formed single slide', () => {
        const slide = {
            index: 0,
            type: 'content',
            elements: [{ kind: 'text', content: 'hi', level: 'body' }],
        };
        expect(isRichSlideArray([slide])).toBe(true);
    });

    it('accepts all four slide types', () => {
        const slides = ['title', 'section', 'content', 'closing'].map((t, i) => ({
            index: i,
            type: t,
            elements: [],
        }));
        expect(isRichSlideArray(slides)).toBe(true);
    });

    it('accepts all six element kinds', () => {
        const slide = {
            index: 0,
            type: 'content',
            elements: [
                { kind: 'text', content: 't', level: 'body' },
                { kind: 'list', items: ['a'], ordered: false },
                { kind: 'table', headers: ['h'], rows: [['v']] },
                { kind: 'stat-card', label: 'l', value: 'v' },
                { kind: 'image', src: 'data:image/png;base64,AAA' },
                { kind: 'spacer' },
            ],
        };
        expect(isRichSlideArray([slide])).toBe(true);
    });

    it('rejects non-array input', () => {
        expect(isRichSlideArray(null)).toBe(false);
        expect(isRichSlideArray(undefined)).toBe(false);
        expect(isRichSlideArray({})).toBe(false);
        expect(isRichSlideArray('slides')).toBe(false);
    });

    it('rejects slide with missing index', () => {
        expect(isRichSlideArray([{ type: 'content', elements: [] }])).toBe(false);
    });

    it('rejects invalid slide type', () => {
        expect(isRichSlideArray([{ index: 0, type: 'overture', elements: [] }])).toBe(false);
    });

    it('rejects invalid element kind', () => {
        const bad = { index: 0, type: 'content', elements: [{ kind: 'hologram' }] };
        expect(isRichSlideArray([bad])).toBe(false);
    });

    it('rejects element with no kind field', () => {
        const bad = { index: 0, type: 'content', elements: [{ content: 'loose' }] };
        expect(isRichSlideArray([bad])).toBe(false);
    });
});
