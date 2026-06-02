// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { sanitizeSvgMarkup, stripDangerousHtml } from '../../src/utils/svgSanitize';

describe('sanitizeSvgMarkup (relocated, neutral util)', () => {
    it('keeps allowlisted geometry, strips scripts + on* + href', () => {
        const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="x()">`
            + `<path d="M0 0L1 1" fill="#1A3A5C" onclick="hack()"/>`
            + `<script>alert(1)</script>`
            + `<a href="javascript:bad()"><rect x="0" y="0" width="2" height="2"/></a>`
            + `</svg>`;
        const clean = sanitizeSvgMarkup(dirty);
        expect(clean).toContain('<path');
        expect(clean).toContain('d="M0 0L1 1"');
        expect(clean.toLowerCase()).not.toContain('onload');
        expect(clean.toLowerCase()).not.toContain('onclick');
        expect(clean.toLowerCase()).not.toContain('<script');
        expect(clean.toLowerCase()).not.toContain('<a');       // <a> not allowlisted
        expect(clean.toLowerCase()).not.toContain('href');
    });
    it('returns empty string for non-SVG / unparseable input (fail-closed)', () => {
        expect(sanitizeSvgMarkup('<div>not svg</div>')).toBe('');
    });
    it('drops EXTERNAL url() in paint attributes, keeps internal url(#…) (H4)', () => {
        const dirty = `<svg xmlns="http://www.w3.org/2000/svg">`
            + `<rect fill="url(http://evil/x)" x="0" y="0" width="2" height="2"/>`
            + `<circle fill="url(#grad)" cx="1" cy="1" r="1"/></svg>`;
        const clean = sanitizeSvgMarkup(dirty);
        expect(clean.toLowerCase()).not.toContain('url(http');   // external paint server dropped
        expect(clean).toContain('url(#grad)');                   // internal ref kept
    });
});

describe('stripDangerousHtml (relocated, defence-in-depth)', () => {
    it('removes script tags, inline handlers and javascript: URLs', () => {
        const dirty = `<div onclick="hack()">hi</div><script>bad()</script><a href="javascript:x">y</a>`;
        const clean = stripDangerousHtml(dirty);
        expect(clean).not.toContain('<script');
        expect(clean.toLowerCase()).not.toContain('onclick');
        expect(clean.toLowerCase()).not.toContain('javascript:');
        expect(clean).toContain('hi');   // benign content preserved
    });
});
