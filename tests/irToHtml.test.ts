// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderDeckToHtml } from '../src/services/presentationIr/irToHtml';
import { validateDeckIr, IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';
import { sanitizePresentation } from '../src/services/chat/presentationSanitizer';
import { resolveTheme } from '../src/services/export/exportTheme';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';

const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);

describe('renderDeckToHtml', () => {
    it('returns ok and one <section data-slide> per slide', () => {
        const r = renderDeckToHtml(coffeeDeckIr, theme);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const sections = r.value.html.match(/<section data-slide/g) ?? [];
        expect(sections.length).toBe(coffeeDeckIr.slides.length);
    });

    it('emits a hidden speaker-notes aside for slides that have notes', () => {
        const r = renderDeckToHtml(coffeeDeckIr, theme);
        if (!r.ok) throw new Error('expected ok');
        const notes = r.value.html.match(/class="speaker-notes"/g) ?? [];
        const withNotes = coffeeDeckIr.slides.filter(s => s.notes).length;
        expect(notes.length).toBe(withNotes);
        expect(r.value.html).toContain('class="speaker-notes" style="display:none;"');
    });

    it('sizes every slide to the fixed 1920x1080 canvas (px, not relative units)', () => {
        const r = renderDeckToHtml(coffeeDeckIr, theme);
        if (!r.ok) throw new Error('expected ok');
        const slides = r.value.html.match(/width:1920px;height:1080px/g) ?? [];
        expect(slides.length).toBe(coffeeDeckIr.slides.length);
        // No platform-relative units that would break the fixed-canvas scale.
        expect(r.value.html).not.toMatch(/font-size:\s*[\d.]+rem/);
    });

    it('does NOT duplicate bar-chart percentages (the "37% 37%" regression)', () => {
        const r = renderDeckToHtml(coffeeDeckIr, theme);
        if (!r.ok) throw new Error('expected ok');
        // Brazil's 37% appears as VISIBLE text exactly once (the `width:37%`
        // CSS is not a visible duplicate). Match the text node, not the style.
        expect((r.value.html.match(/>37%</g) ?? []).length).toBe(1);
    });

    it('renders emoji icons on stat-grid cards and process-flow steps', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            title: 'Icons',
            slides: [{
                id: 'i1',
                type: 'content',
                title: 'With icons',
                blocks: [
                    { kind: 'stat-grid', cards: [{ value: '$100B', label: 'Market', icon: '📈' }] },
                    { kind: 'process-flow', steps: [
                        { title: 'Grow', icon: '🌱' },
                        { title: 'Ship', icon: '🚚' },
                    ] },
                ],
            }],
        };
        expect(validateDeckIr(deck).ok).toBe(true);
        const r = renderDeckToHtml(deck, theme);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.html).toContain('📈');
        expect(r.value.html).toContain('🌱');
        expect(r.value.html).toContain('🚚');
    });

    it('applies a per-slide background override with auto-contrast text', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            title: 'Bg',
            slides: [
                { id: 't1', type: 'title', title: 'White title', subtitle: 'sub', background: 'ffffff', blocks: [] },
                { id: 'c1', type: 'closing', title: 'Dark closing', background: '101020', blocks: [] },
            ],
        };
        expect(validateDeckIr(deck).ok).toBe(true);
        const r = renderDeckToHtml(deck, theme);
        if (!r.ok) throw new Error('expected ok');
        // White background present and the title text is dark (not white) for contrast.
        expect(r.value.html).toContain('background:#ffffff');
        expect(r.value.html).toContain('color:#1a1a2e');
        // Dark background present with white text.
        expect(r.value.html).toContain('background:#101020');
        expect(r.value.html).toContain('color:#ffffff');
    });

    it('renders two-column as a flex container with two columns', () => {
        const r = renderDeckToHtml(coffeeDeckIr, theme);
        if (!r.ok) throw new Error('expected ok');
        expect((r.value.html.match(/class="ir-cols"/g) ?? []).length).toBeGreaterThanOrEqual(1);
        expect((r.value.html.match(/class="ir-col"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('strips active content from a malicious deck (H1 security gate)', () => {
        const malicious: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{
                id: 'm', type: 'content', title: 'x', blocks: [
                    { kind: 'svg', svg: '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5"/></svg>' },
                    { kind: 'custom', html: '<div><img src="x" onerror="alert(3)"><b/onmouseover="alert(4)">hi</b></div>' },
                ],
            }],
        };
        // Validates (svg markup + custom html are allowed at the schema level).
        expect(validateDeckIr(malicious).ok).toBe(true);
        const r = renderDeckToHtml(malicious, theme);
        if (!r.ok) throw new Error('expected ok');
        // The renderer output is safe-by-default (defense-in-depth), BEFORE the
        // service-level sanitizer runs (audit H2/H5).
        expect(r.value.html).not.toContain('<script');
        expect(r.value.html).not.toContain('onerror');
        expect(r.value.html).not.toContain('onload');
        expect(r.value.html).not.toContain('onmouseover'); // slash-separated handler (G2)
        // And remains safe through the full service sanitizer (belt-and-braces).
        const safe = sanitizePresentation(r.value.html);
        expect(safe.html).not.toContain('<script');
        expect(safe.html).not.toContain('onerror');
    });

    it('round-trips non-ASCII SVG content through base64 without corruption (G1)', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'g', type: 'content', title: 't', blocks: [
                { kind: 'svg', svg: '<svg viewBox="0 0 10 10"><text x="0" y="5">café — €99 — 日本</text></svg>' },
            ] }],
        };
        const r = renderDeckToHtml(deck, theme);
        if (!r.ok) throw new Error('expected ok');
        // irToHtml inlines sanitized SVG; the non-ASCII text must survive intact.
        expect(r.value.html).toContain('café — €99 — 日本');
    });

    it('image-present custom block renders an <img> (G3 precedence parity)', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'c', type: 'content', blocks: [
                { kind: 'custom', image: 'data:image/png;base64,iVBORw0KGgo=', html: '<b>ignored</b>' },
            ] }],
        };
        const r = renderDeckToHtml(deck, theme);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.html).toContain('<img');
        expect(r.value.html).not.toContain('ignored');
    });
});
