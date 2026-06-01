import { describe, it, expect } from 'vitest';
import {
    assertHexColor,
    renderIconSvgMarkup,
    gradientSvgMarkup,
    svgMarkupToDataUri,
    addSvgImageSafe,
    createSvgAssetCache,
    type SvgImageSlide,
} from '../src/services/presentationIr/svgAsset';

describe('assertHexColor', () => {
    it('accepts 6-digit hex with or without #', () => {
        expect(assertHexColor('1A3A5C')).toBe('1A3A5C');
        expect(assertHexColor('#F5C842')).toBe('F5C842');
    });
    it('rejects malformed hex', () => {
        for (const bad of ['12345', '1234567', 'GGGGGG', 'red', '', '#xyz']) {
            expect(() => assertHexColor(bad), bad).toThrow();
        }
    });
});

describe('renderIconSvgMarkup', () => {
    it('builds namespaced, colour-guarded stroke SVG for a known icon', () => {
        const svg = renderIconSvgMarkup('trending-up', '1A3A5C');
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');   // OOXML mandatory
        expect(svg).toContain('viewBox="0 0 24 24"');
        expect(svg).toContain('stroke="#1A3A5C"');
        expect(svg).toContain('<path d="');
    });
    it('throws on unknown icon and bad colour', () => {
        expect(() => renderIconSvgMarkup('nope', '1A3A5C')).toThrow();
        expect(() => renderIconSvgMarkup('trending-up', 'zzz')).toThrow();
    });
});

describe('gradientSvgMarkup', () => {
    it('builds a namespaced linear-gradient with both stops', () => {
        const svg = gradientSvgMarkup({ from: '1A3A5C', to: '1D6B4A', angleDeg: 135, w: 1280, h: 720 });
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(svg).toContain('<linearGradient');
        expect(svg).toContain('stop-color="#1A3A5C"');
        expect(svg).toContain('stop-color="#1D6B4A"');
        expect(svg).toContain('fill="url(#g)"');
    });
    it('guards stop colours', () => {
        expect(() => gradientSvgMarkup({ from: 'bad', to: '1D6B4A', angleDeg: 135, w: 10, h: 10 })).toThrow();
    });
});

describe('svgMarkupToDataUri + dedup cache', () => {
    it('produces a base64 svg data URI that round-trips', () => {
        const markup = renderIconSvgMarkup('rocket', 'F5C842');
        const uri = svgMarkupToDataUri(markup);
        expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
        const decoded = Buffer.from(uri.split(',')[1], 'base64').toString('utf-8');
        expect(decoded).toBe(markup);
    });
    it('reuses the cached payload for identical markup', () => {
        const cache = createSvgAssetCache();
        const markup = renderIconSvgMarkup('star', '1A3A5C');
        const a = svgMarkupToDataUri(markup, cache);
        const b = svgMarkupToDataUri(markup, cache);
        expect(a).toBe(b);
        expect(cache.size).toBe(1);
    });
});

describe('addSvgImageSafe', () => {
    it('adds the image on success, no fallback', () => {
        let added = 0; let fellBack = 0;
        const s: SvgImageSlide = { addImage: () => { added++; } };
        addSvgImageSafe(s, renderIconSvgMarkup('rocket', '1A3A5C'), { x: 0, y: 0, w: 1, h: 1 }, () => { fellBack++; });
        expect(added).toBe(1); expect(fellBack).toBe(0);
    });
    it('runs fallback when addImage throws', () => {
        let fellBack = 0;
        const s: SvgImageSlide = { addImage: () => { throw new Error('boom'); } };
        addSvgImageSafe(s, renderIconSvgMarkup('rocket', '1A3A5C'), { x: 0, y: 0, w: 1, h: 1 }, () => { fellBack++; });
        expect(fellBack).toBe(1);
    });
    it('never throws even when BOTH addImage and the fallback throw (M10)', () => {
        const s: SvgImageSlide = { addImage: () => { throw new Error('boom'); } };
        expect(() => addSvgImageSafe(s, '<svg/>', { x: 0, y: 0, w: 1, h: 1 }, () => { throw new Error('fallback boom'); })).not.toThrow();
    });
});

describe('gradientSvgMarkup — CSS angle convention (M3)', () => {
    it('135deg runs top-left → bottom-right (matching CSS)', () => {
        const svg = gradientSvgMarkup({ from: '1A3A5C', to: '1D6B4A', angleDeg: 135, w: 100, h: 100 });
        const x1 = Number(/x1="([\d.]+)"/.exec(svg)![1]);
        const y1 = Number(/y1="([\d.]+)"/.exec(svg)![1]);
        const x2 = Number(/x2="([\d.]+)"/.exec(svg)![1]);
        const y2 = Number(/y2="([\d.]+)"/.exec(svg)![1]);
        expect(x1).toBeLessThan(x2);   // left → right
        expect(y1).toBeLessThan(y2);   // top → bottom
    });
    it('90deg runs left → right, no vertical component', () => {
        const svg = gradientSvgMarkup({ from: '000000', to: 'FFFFFF', angleDeg: 90, w: 100, h: 100 });
        const y1 = Number(/y1="([\d.]+)"/.exec(svg)![1]);
        const y2 = Number(/y2="([\d.]+)"/.exec(svg)![1]);
        expect(y1).toBeCloseTo(0.5);
        expect(y2).toBeCloseTo(0.5);
    });
});
