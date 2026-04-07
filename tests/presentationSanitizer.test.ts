import { describe, it, expect } from 'vitest';
import { sanitizePresentation, injectCSP } from '../src/services/chat/presentationSanitizer';

// ── 1. Allowed Tags Pass Through ───────────────────────────────────────────

describe('allowed tags pass through', () => {
    it('preserves clean presentation HTML with structural and text elements', () => {
        const html = '<div class="deck"><section class="slide"><h1>Title</h1><p>Body</p><ul><li>A</li></ul></section></div>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('<div class="deck">');
        expect(result.html).toContain('<section class="slide">');
        expect(result.html).toContain('<h1>Title</h1>');
        expect(result.html).toContain('<p>Body</p>');
        expect(result.html).toContain('<ul>');
        expect(result.html).toContain('<li>A</li>');
        expect(result.rejectionCount).toBe(0);
    });

    it('preserves SVG elements with path and circle', () => {
        const html = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/><path d="M10 10 L90 90" stroke="black"/></svg>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('<svg');
        expect(result.html).toContain('<circle');
        expect(result.html).toContain('<path');
        expect(result.rejectionCount).toBe(0);
    });

    it('preserves table structure with thead, tbody, tr, th, td', () => {
        const html = '<table><thead><tr><th scope="col">Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('<table>');
        expect(result.html).toContain('<thead>');
        expect(result.html).toContain('<tbody>');
        expect(result.html).toContain('<tr>');
        expect(result.html).toContain('<th');
        expect(result.html).toContain('<td>Cell</td>');
        expect(result.rejectionCount).toBe(0);
    });
});

// ── 2. Blocked Tags Stripped ───────────────────────────────────────────────

describe('blocked tags stripped', () => {
    it('removes script tags and increments rejectionCount', () => {
        const html = '<div class="deck"><script>alert(1)</script><p>Safe</p></div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('<script');
        expect(result.html).not.toContain('alert(1)');
        expect(result.html).toContain('<p>Safe</p>');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('removes iframe tags', () => {
        const html = '<div><iframe src="https://evil.com"></iframe><p>OK</p></div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('<iframe');
        expect(result.html).not.toContain('evil.com');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('removes form and input elements', () => {
        const html = '<div><form action="/steal"><input type="text"></form><p>Safe</p></div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('<form');
        expect(result.html).not.toContain('<input');
        expect(result.html).toContain('<p>Safe</p>');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('removes object and embed elements', () => {
        const html = '<div><object data="evil.swf"><embed src="evil.swf"></object><p>OK</p></div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('<object');
        expect(result.html).not.toContain('<embed');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('removes link tags', () => {
        const html = '<div><link rel="stylesheet" href="evil.css"><p>OK</p></div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('<link');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });
});

// ── 3. Attribute Filtering ─────────────────────────────────────────────────

describe('attribute filtering', () => {
    it('removes onclick event handler', () => {
        const html = '<div onclick="alert(1)">Click me</div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('onclick');
        expect(result.html).not.toContain('alert');
        expect(result.html).toContain('>Click me</div>');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('removes onerror event handler on img', () => {
        const html = '<img src="data:image/png;base64,abc" onerror="alert(1)">';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('onerror');
        expect(result.html).toContain('src="data:image/png;base64,abc"');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('preserves class attribute', () => {
        const html = '<div class="slide slide-title">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('class="slide slide-title"');
        expect(result.rejectionCount).toBe(0);
    });

    it('preserves data-title attribute', () => {
        const html = '<div data-title="Test Deck">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('data-title="Test Deck"');
        expect(result.rejectionCount).toBe(0);
    });

    it('preserves role and aria-label attributes', () => {
        const html = '<div role="region" aria-label="test section">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('role="region"');
        expect(result.html).toContain('aria-label="test section"');
        expect(result.rejectionCount).toBe(0);
    });
});

// ── 4. URL Sanitization ───────────────────────────────────────────────────

describe('URL sanitization', () => {
    it('removes javascript: href', () => {
        const html = '<a href="javascript:alert(1)">Link</a>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('javascript:');
        expect(result.html).toContain('>Link</a>');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('preserves https href', () => {
        const html = '<a href="https://example.com">Link</a>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('href="https://example.com"');
        expect(result.rejectionCount).toBe(0);
    });

    it('preserves data: URI on img src', () => {
        const html = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart">';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
        expect(result.rejectionCount).toBe(0);
    });

    it('removes remote https image src (no remote images allowed)', () => {
        const html = '<img src="https://evil.com/tracking.png" alt="img">';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('https://evil.com');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });
});

// ── 5. CSS Property Validation ─────────────────────────────────────────────

describe('CSS property validation', () => {
    it('preserves safe CSS properties like color and font-size', () => {
        const html = '<p style="color: red; font-size: 14px">Text</p>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('color: red');
        expect(result.html).toContain('font-size: 14px');
        expect(result.rejectionCount).toBe(0);
    });

    it('strips expression() CSS value', () => {
        const html = '<p style="width: expression(alert(1))">Text</p>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('expression');
    });

    it('strips behavior: CSS value', () => {
        const html = '<p style="behavior: url(evil.htc)">Text</p>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('behavior');
    });

    it('preserves background-image with data: URI', () => {
        const html = '<div style="background-image: url(data:image/png;base64,abc)">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).toContain('background-image: url(data:image/png;base64,abc)');
    });

    it('strips background with remote url()', () => {
        const html = '<div style="background: url(https://evil.com/bg.png)">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('evil.com');
    });
});

// ── 6. CSP Injection ──────────────────────────────────────────────────────

describe('CSP injection', () => {
    it('adds CSP meta tag inside head', () => {
        const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>';
        const result = injectCSP(html);
        expect(result).toContain('Content-Security-Policy');
        expect(result).toContain("default-src 'none'");
        // CSP should appear after <head>
        const headIdx = result.indexOf('<head>');
        const cspIdx = result.indexOf('Content-Security-Policy');
        expect(cspIdx).toBeGreaterThan(headIdx);
    });

    it('does not duplicate CSP if already present', () => {
        const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>';
        const result = injectCSP(html);
        const count = (result.match(/Content-Security-Policy/g) ?? []).length;
        expect(count).toBe(1);
    });
});

// ── 7. Structural Detection ───────────────────────────────────────────────

describe('structural detection', () => {
    it('detects .deck root and .slide children', () => {
        const html = '<div class="deck"><section class="slide slide-title"><h1>Hi</h1></section></div>';
        const result = sanitizePresentation(html);
        expect(result.hasDeckRoot).toBe(true);
        expect(result.hasSlides).toBe(true);
    });

    it('reports hasDeckRoot=false when .deck is absent', () => {
        const html = '<div class="container"><section class="slide"><h1>Hi</h1></section></div>';
        const result = sanitizePresentation(html);
        expect(result.hasDeckRoot).toBe(false);
        expect(result.hasSlides).toBe(true);
    });

    it('reports hasSlides=false when .slide is absent', () => {
        const html = '<div class="deck"><section class="panel"><h1>Hi</h1></section></div>';
        const result = sanitizePresentation(html);
        expect(result.hasDeckRoot).toBe(true);
        expect(result.hasSlides).toBe(false);
    });
});

// ── 8. Edge Cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('handles empty string', () => {
        const result = sanitizePresentation('');
        expect(result.html).toBe('');
        expect(result.rejectionCount).toBe(0);
        expect(result.hasDeckRoot).toBe(false);
        expect(result.hasSlides).toBe(false);
    });

    it('handles malformed HTML with unclosed tags gracefully', () => {
        const html = '<div class="deck"><section class="slide"><h1>Title<p>Missing close</section></div>';
        const result = sanitizePresentation(html);
        // Should not throw — best-effort parse
        expect(result.html).toContain('Title');
        expect(result.html).toContain('Missing close');
        expect(result.hasDeckRoot).toBe(true);
    });

    it('strips encoded event handlers (&#x6f;nclick bypass attempt)', () => {
        const html = '<div &#x6f;nclick="alert(1)">Content</div>';
        const result = sanitizePresentation(html);
        expect(result.html).not.toContain('alert');
        expect(result.html).toContain('>Content</div>');
        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });
});
