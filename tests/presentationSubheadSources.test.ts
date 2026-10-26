// @vitest-environment jsdom
/**
 * Slide designer quick wins: the real `subhead` block, slide-level `sources` /
 * `footnotes` (schema, HTML + PPTX parity, translator provenance), the grounded
 * few-shot and the shared visual-selection guidance.
 *
 * jsdom (not happy-dom): the preview HTML goes through the real sanitizer.
 */
import { describe, it, expect } from 'vitest';
import { renderDeckToHtml } from '../src/services/presentationIr/irToHtml';
import { renderDeckToPptx } from '../src/services/presentationIr/irToPptx';
import { IR_RENDER_SPEC } from '../src/services/presentationIr/irRenderSpec';
import { sanitizePresentation } from '../src/services/chat/presentationSanitizer';
import {
    IR_SCHEMA_VERSION, MAX_SLIDE_FOOTNOTES, MAX_SLIDE_SOURCES, validateDeckIr, type SlideDeckIr, type SlideIr,
} from '../src/services/presentationIr/slideIr';
import { slideFooterLines, deckSourceGaps, DEFAULT_SOURCE_LABEL } from '../src/services/presentationIr/slideFooter';
import { formatSourceRef, translateStoryboardToIr } from '../src/services/presentationIr/storyboardService';
import type { ConsultantStoryboard, EvidenceSpan } from '../src/services/presentationIr/consultantStoryboard';
import { buildIrSystemPrompt, parseIrFromResponse } from '../src/services/presentationIr/irPrompts';
import { buildStoryboardPrompt, buildStoryboardRevisionPrompt } from '../src/services/presentationIr/storyboardPrompts';
import { buildVisualSelectionGuide } from '../src/services/presentationIr/visualSelection';
import { isKnownIcon } from '../src/services/presentationIr/iconRegistry';
import { resolveTheme } from '../src/services/export/exportTheme';

const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);
const deck = (slides: SlideIr[]): SlideDeckIr => ({ schemaVersion: IR_SCHEMA_VERSION, slides });
const content = (extra: Partial<SlideIr> & { blocks: SlideIr['blocks'] }): SlideIr => ({ id: 's1', type: 'content', title: 'T', ...extra });

// ── Capturing pptxgenjs stub (same shape the parity tests use) ───────────────
interface Call { method: string; args: unknown[] }
class CapSlide {
    calls: Call[] = [];
    background: { color: string } | undefined;
    addText(...a: unknown[]) { this.calls.push({ method: 'addText', args: a }); }
    addShape(...a: unknown[]) { this.calls.push({ method: 'addShape', args: a }); }
    addTable(...a: unknown[]) { this.calls.push({ method: 'addTable', args: a }); }
    addChart(...a: unknown[]) { this.calls.push({ method: 'addChart', args: a }); }
    addImage(...a: unknown[]) { this.calls.push({ method: 'addImage', args: a }); }
    addNotes() { /* not asserted */ }
}
class CapPptx {
    layout = '';
    slides: CapSlide[] = [];
    addSlide() { const s = new CapSlide(); this.slides.push(s); return s; }
    async write() { return new ArrayBuffer(16); }
}
async function pptxSlides(d: SlideDeckIr, opts: { sourceLabel?: string } = {}): Promise<CapSlide[]> {
    const instances: CapPptx[] = [];
    class Wrapped extends CapPptx { constructor() { super(); instances.push(this); } }
    const r = await renderDeckToPptx(d, theme, { pptxModule: Wrapped as unknown as never, ...opts });
    expect(r.ok).toBe(true);
    return instances[0]?.slides ?? [];
}
function html(d: SlideDeckIr, opts: { sourceLabel?: string } = {}): string {
    const r = renderDeckToHtml(d, theme, opts);
    expect(r.ok).toBe(true);
    return r.ok ? r.value.html : '';
}

describe('subhead block — schema', () => {
    it('validates at slide level and inside a two-column block', () => {
        const r = validateDeckIr(deck([content({ blocks: [
            { kind: 'subhead', text: 'Services revenue rose 12%' },
            { kind: 'two-column', left: [{ kind: 'subhead', text: 'Left' }], right: [{ kind: 'paragraph', text: 'Right' }] },
        ] })]));
        expect(r.ok).toBe(true);
    });
    it('rejects an empty subhead, but STRIPS a stray key (an old emphasis habit must not fail the deck)', () => {
        expect(validateDeckIr(deck([content({ blocks: [{ kind: 'subhead', text: '' }] })])).ok).toBe(false);
        const r = validateDeckIr(deck([content({ blocks: [{ kind: 'subhead', text: 'x', emphasis: true } as never] })]));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides[0].blocks[0]).toEqual({ kind: 'subhead', text: 'x' });
    });
    it('old decks keep working: a paragraph with emphasis is still valid', () => {
        expect(validateDeckIr(deck([content({ blocks: [{ kind: 'paragraph', text: 'Key', emphasis: true }] })])).ok).toBe(true);
    });
});

describe('sources / footnotes — schema degrades instead of failing', () => {
    const parse = (extra: Record<string, unknown>) => {
        const r = validateDeckIr({ schemaVersion: IR_SCHEMA_VERSION, slides: [{ id: 's1', type: 'content', blocks: [], ...extra }] });
        expect(r.ok).toBe(true);
        return r.ok ? r.value.slides[0] : (undefined as never);
    };
    it('keeps a clean list and trims whitespace', () => {
        expect(parse({ sources: ['  IEA,   2024 ', 'Annual report'] }).sources).toEqual(['IEA, 2024', 'Annual report']);
    });
    it('a non-array, an empty list and blank entries become absent, not an error', () => {
        expect(parse({ sources: 'IEA' }).sources).toBeUndefined();
        expect(parse({ sources: [] }).sources).toBeUndefined();
        expect(parse({ footnotes: ['', '   ', 7, null] }).footnotes).toBeUndefined();
    });
    it('drops non-string entries but keeps the good ones', () => {
        expect(parse({ footnotes: ['Excludes one-offs', 42, { x: 1 }] }).footnotes).toEqual(['Excludes one-offs']);
    });
    it('truncates an over-long line and caps the list', () => {
        const long = 'x'.repeat(900);
        const s = parse({ sources: Array.from({ length: 20 }, (_, i) => (i === 0 ? long : `S${i}`)), footnotes: Array.from({ length: 9 }, (_, i) => `N${i}`) });
        expect(s.sources).toHaveLength(MAX_SLIDE_SOURCES);
        expect(s.sources![0].length).toBeLessThanOrEqual(200);
        expect(s.sources![0].endsWith('…')).toBe(true);
        expect(s.footnotes).toHaveLength(MAX_SLIDE_FOOTNOTES);
    });
});

describe('slideFooter — one text for both renderers', () => {
    it('footnotes first, then one labelled source line', () => {
        expect(slideFooterLines({ footnotes: ['Excludes one-offs'], sources: ['IEA, 2024', 'Annual report'] }))
            .toEqual(['Excludes one-offs', `${DEFAULT_SOURCE_LABEL}: IEA, 2024; Annual report`]);
    });
    it('uses a localised label, and falls back when the label is blank', () => {
        expect(slideFooterLines({ sources: ['Bron A'] }, 'Bron')).toEqual(['Bron: Bron A']);
        expect(slideFooterLines({ sources: ['A'] }, '  ')).toEqual([`${DEFAULT_SOURCE_LABEL}: A`]);
    });
    it('is empty when the slide has neither', () => {
        expect(slideFooterLines({})).toEqual([]);
    });
});

describe('deckSourceGaps — figures without a source are reported, never invented', () => {
    const bars = { kind: 'bar-chart' as const, bars: [{ label: 'A (1)', pct: 100 }] };
    it('flags a figure slide with no source, and not once it has one', () => {
        expect(deckSourceGaps(deck([content({ blocks: [bars] })]))).toEqual([0]);
        expect(deckSourceGaps(deck([content({ blocks: [bars], sources: ['IEA'] })]))).toEqual([]);
    });
    it('a bar chart that carries its own `source` counts as sourced', () => {
        expect(deckSourceGaps(deck([content({ blocks: [{ ...bars, source: 'IEA, 2024' }] })]))).toEqual([]);
    });
    it('sees figures inside a two-column block; text-only slides are never flagged', () => {
        expect(deckSourceGaps(deck([content({ blocks: [{ kind: 'two-column', left: [bars], right: [] }] })]))).toEqual([0]);
        expect(deckSourceGaps(deck([content({ blocks: [{ kind: 'paragraph', text: 'Prose' }] })]))).toEqual([]);
    });
});

describe('HTML / PPTX parity — subhead and footer', () => {
    const d = deck([content({
        title: 'Services grew',
        blocks: [{ kind: 'subhead', text: 'Services revenue rose 12%' }, { kind: 'paragraph', text: 'Body' }],
        footnotes: ['Excludes one-offs'],
        sources: ['Example Co annual report'],
    })]);

    it('HTML: the subhead is bold in the primary colour at the spec size', () => {
        const out = html(d);
        const primary = theme.primaryColor.replace('#', '').toUpperCase();
        const m = out.match(/<p style="([^"]*)">Services revenue rose 12%<\/p>/);
        expect(m).not.toBeNull();
        expect(m![1]).toContain('font-weight:700');
        expect(m![1].toUpperCase()).toContain(`COLOR:#${primary}`);
        expect(m![1]).toContain(`font-size:${Math.round(IR_RENDER_SPEC.font.subheadPt(theme) * 2)}px`);
    });
    it('PPTX: the same subhead is bold, primary, at the spec pt', async () => {
        const [s] = await pptxSlides(d);
        const call = s.calls.find(c => c.method === 'addText' && c.args[0] === 'Services revenue rose 12%');
        expect(call).toBeDefined();
        const o = call!.args[1] as { bold: boolean; color: string; fontSize: number };
        expect(o.bold).toBe(true);
        expect(o.color.toUpperCase()).toBe(theme.primaryColor.replace('#', '').toUpperCase());
        expect(o.fontSize).toBe(IR_RENDER_SPEC.font.subheadPt(theme));
    });
    it('both renderers print the SAME footer lines', async () => {
        const lines = slideFooterLines(d.slides[0]);
        const out = html(d);
        for (const l of lines) expect(out).toContain(l);
        const [s] = await pptxSlides(d);
        const call = s.calls.find(c => c.method === 'addText' && c.args[0] === lines.join('\n'));
        expect(call).toBeDefined();
        expect((call!.args[1] as { fontSize: number }).fontSize).toBe(IR_RENDER_SPEC.font.footerLinePt(theme));
    });
    it('a localised source label reaches both renderers', async () => {
        expect(html(d, { sourceLabel: 'Bron' })).toContain('Bron: Example Co annual report');
        const [s] = await pptxSlides(d, { sourceLabel: 'Bron' });
        expect(s.calls.some(c => c.method === 'addText' && String(c.args[0]).includes('Bron: Example Co annual report'))).toBe(true);
    });
    it('a slide without sources/footnotes draws no footer in either', async () => {
        const plain = deck([content({ blocks: [{ kind: 'paragraph', text: 'Body' }] })]);
        expect(html(plain)).not.toContain('ir-footer');
        const [s] = await pptxSlides(plain);
        expect(s.calls.filter(c => c.method === 'addText').every(c => !String(c.args[0]).includes(DEFAULT_SOURCE_LABEL))).toBe(true);
    });
    it('PPTX takes the footer out of the content zone: a block that fits without it is dropped with it', async () => {
        const slideWith = (extra: Partial<SlideIr>) => deck([content({
            blocks: [{ kind: 'paragraph', text: 'First' }, { kind: 'bullets', items: Array.from({ length: 11 }, (_, i) => `Item ${i}`) }, { kind: 'paragraph', text: 'LAST-BLOCK' }],
            ...extra,
        })]);
        const drawn = async (d2: SlideDeckIr) => (await pptxSlides(d2))[0].calls.some(c => c.method === 'addText' && c.args[0] === 'LAST-BLOCK');
        expect(await drawn(slideWith({}))).toBe(true);
        expect(await drawn(slideWith({ footnotes: ['a', 'b', 'c', 'd'], sources: ['S'] }))).toBe(false);
    });
    it('PPTX footer sits ABOVE the footer band and is height-capped', async () => {
        const long = Array.from({ length: 4 }, (_, i) => `Footnote ${i} ${'word '.repeat(60)}`);
        const [s] = await pptxSlides(deck([content({ blocks: [{ kind: 'paragraph', text: 'Body' }], footnotes: long, sources: Array.from({ length: 6 }, (_, i) => `Source ${i} ${'x'.repeat(150)}`) })]));
        const call = s.calls.find(c => c.method === 'addText' && String(c.args[0]).includes('Footnote 0'));
        const o = call!.args[1] as { y: number; h: number; transparency: number };
        const fg = IR_RENDER_SPEC.geometry.footer;
        expect(o.h).toBeLessThanOrEqual(fg.maxIn);
        expect(o.y + o.h).toBeLessThanOrEqual(7.1 - fg.bandClearIn + 1e-9);   // default band start
        expect(o.transparency).toBe(35);
        // text that still wraps past the capped box shrinks to fit instead of spilling over the content
        expect((call!.args[1] as { fit: string }).fit).toBe('shrink');
    });
    it('with a brand safe area the footer clears the brand footer band', async () => {
        const branded = { ...theme, safeArea: { sideMarginIn: 0.6, logoReserveIn: 1.2, contentTopIn: 1.4, footerBandIn: 6.7 } };
        const instances: CapPptx[] = [];
        class W extends CapPptx { constructor() { super(); instances.push(this); } }
        const r = await renderDeckToPptx(d, branded as never, { pptxModule: W as unknown as never });
        expect(r.ok).toBe(true);
        const call = instances[0].slides[0].calls.find(c => c.method === 'addText' && String(c.args[0]).includes('Source:'));
        const o = call!.args[1] as { y: number; h: number };
        expect(o.y + o.h).toBeLessThanOrEqual(6.7);
    });
    it('a slide with a custom background gets the contrast colour on its PPTX footer', async () => {
        const dark = deck([content({ background: '111111', blocks: [{ kind: 'paragraph', text: 'Body' }], sources: ['S'] })]);
        const [s] = await pptxSlides(dark);
        const call = s.calls.find(c => c.method === 'addText' && String(c.args[0]).includes('Source:'));
        expect((call!.args[1] as { color: string }).color).toBe('ffffff');
    });
    it('the sanitizer keeps the subhead and every footer line (only allow-listed CSS is used)', () => {
        const out = sanitizePresentation(html(d));
        expect(out.html).toContain('Services revenue rose 12%');
        expect(out.html).toContain('Excludes one-offs');
        expect(out.html).toContain('Source: Example Co annual report');
        // the footer keeps its sizing/opacity — none of its declarations were stripped
        const footer = out.html.match(/<div class="ir-footer" style="([^"]*)"/);
        expect(footer?.[1]).toContain('margin-top');
        // (the sanitizer re-serialises CSS through the CSSOM: spaces and rgb() colours)
        expect(out.html).toMatch(/font-size: \d+px; line-height: 1\.3; color: rgb\([^)]+\); opacity: 0\.65/);
        expect(out.html).toMatch(/font-size: 32px; font-weight: 700; line-height: 1\.3; color: rgb\(/);
    });
});

describe('translator — sources come from the cited evidence only', () => {
    const catalog: EvidenceSpan[] = [
        { id: 'e1', source_ref: '2 Areas/Finance/Example Co annual report.md', text: 'Services revenue was 4.1 EUR bn in FY24.' },
        { id: 'e2', source_ref: 'https://www.example.com/report/fy24', text: 'Hardware revenue was 5.9 EUR bn in FY24.' },
        { id: 'e3', source_ref: 'notes/unused.md', text: 'Not cited.' },
    ];
    const sb = (slides: ConsultantStoryboard['slides']): ConsultantStoryboard => ({ schemaVersion: 1, thesis: 'Thesis', slides } as ConsultantStoryboard);
    const barSlide = {
        id: 's1', role: 'insight', action_title: 'Services grew 12%', core_message: 'Services rose.', evidence_span_ids: ['e1', 'e2', 'gone'],
        suggested_visual: 'bar',
        visual_data: { type: 'bar', unit: 'EUR bn', items: [{ label: 'Services', value: 4.1, evidence_span_id: 'e1' }, { label: 'Hardware', value: 5.9, evidence_span_id: 'e2' }] },
    } as ConsultantStoryboard['slides'][number];

    it('names the distinct origins of the cited spans, readable and without invented text', () => {
        const r = translateStoryboardToIr(sb([barSlide]), catalog);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.slides[1].sources).toEqual(['Example Co annual report', 'example.com']);
        expect(deckSourceGaps(r.value)).toEqual([]);
    });
    it('ignores a dangling id and never cites an uncited span', () => {
        const r = translateStoryboardToIr(sb([barSlide]), catalog);
        if (!r.ok) throw new Error('expected ok');
        expect(JSON.stringify(r.value.slides[1].sources)).not.toContain('unused');
        expect(JSON.stringify(r.value.slides[1].sources)).not.toContain('gone');
    });
    it('adds no sources without a catalog (a deck rebuilt from a saved note)', () => {
        const r = translateStoryboardToIr(sb([barSlide]));
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.slides[1].sources).toBeUndefined();
    });
    it('placeholder refs ("active note", a raw web-search query) are never cited as sources', () => {
        const cat: EvidenceSpan[] = [
            { id: 'e1', source_ref: 'active note', text: 'x' },
            { id: 'e2', source_ref: 'coffee market size 2024', text: 'y' },
            { id: 'e3', source_ref: 'Notes/Real source.md', text: 'z' },
        ];
        const sl = { ...barSlide, evidence_span_ids: ['e1', 'e2', 'e3'], visual_data: { type: 'bar', items: [{ label: 'A', value: 1, evidence_span_id: 'e1' }, { label: 'B', value: 2, evidence_span_id: 'e2' }] } } as ConsultantStoryboard['slides'][number];
        const r = translateStoryboardToIr(sb([sl]), cat);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.slides[1].sources).toEqual(['Real source']);
    });
    it('"Q3 plan" and "3 priorities" are not figures; "12%" and "$4.1bn" are', () => {
        const mk = (title: string) => ({ id: 'q', role: 'context', action_title: title, core_message: 'Text.', evidence_span_ids: ['e1'], suggested_visual: 'bullets', visual_data: { type: 'bullets' } }) as ConsultantStoryboard['slides'][number];
        const src = (t: string) => { const r = translateStoryboardToIr(sb([mk(t)]), catalog); return r.ok ? r.value.slides[1].sources : 'err'; };
        expect(src('Q3 plan: 3 priorities')).toBeUndefined();
        expect(src('Services grew 12%')).toEqual(['Example Co annual report']);
        expect(src('Revenue reached $4.1bn')).toEqual(['Example Co annual report']);
        expect(src('Revenue reached 5 EUR bn')).toEqual(['Example Co annual report']);
        expect(src('Revenue reached 4 EUR')).toEqual(['Example Co annual report']);
        expect(src('Three and 3 and more')).toBeUndefined();
    });
    it('a web-search query is not an origin, even with a slash or digits in it', () => {
        const cat: EvidenceSpan[] = [
            { id: 'e1', source_ref: 'coffee market size 2023/2024', text: 'x' },
            { id: 'e2', source_ref: 'EV/EBITDA forecast 2024', text: 'y' },
            { id: 'e3', source_ref: 'Notes/Real source.md', text: 'z' },
            { id: 'e4', source_ref: 'Docs/Long extension.markdown', text: 'w' },
        ];
        const sl = { ...barSlide, evidence_span_ids: ['e1', 'e2', 'e3', 'e4'], visual_data: { type: 'bar', items: [{ label: 'A', value: 1, evidence_span_id: 'e1' }] } } as ConsultantStoryboard['slides'][number];
        const r = translateStoryboardToIr(sb([sl]), cat);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.slides[1].sources).toEqual(['Real source', 'Long extension']);
    });
    it('a qualitative slide (no figures) gets no source line', () => {
        const prose = { id: 's2', role: 'context', action_title: 'The market is shifting', core_message: 'Buyers want services.', evidence_span_ids: ['e1'], suggested_visual: 'bullets', visual_data: { type: 'bullets' } } as ConsultantStoryboard['slides'][number];
        const r = translateStoryboardToIr(sb([prose]), catalog);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.slides[1].sources).toBeUndefined();
    });
    it('a number in the title counts as showing figures even without a numeric visual', () => {
        const titled = { id: 's3', role: 'insight', action_title: 'Services reached 4.1 EUR bn', core_message: 'Up.', evidence_span_ids: ['e1'], suggested_visual: 'bullets', visual_data: { type: 'bullets' } } as ConsultantStoryboard['slides'][number];
        const r = translateStoryboardToIr(sb([titled]), catalog);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.slides[1].sources).toEqual(['Example Co annual report']);
    });
    it('does not alter the storyboard or its evidence ids (grounding stays intact)', () => {
        const before = JSON.stringify(sb([barSlide]));
        const input = sb([barSlide]);
        translateStoryboardToIr(input, catalog);
        expect(JSON.stringify(input)).toBe(before);
    });
    it('formatSourceRef: note name, host, plain text', () => {
        expect(formatSourceRef('a/b/Quarterly review.md')).toBe('Quarterly review');
        expect(formatSourceRef('C:\\vault\\x\\Report.pdf')).toBe('Report');
        expect(formatSourceRef('https://www.iea.org/reports/x')).toBe('iea.org');
        expect(formatSourceRef('Some source')).toBe('Some source');
    });
});

describe('IR prompt — grounded few-shot, selection guidance, icons, subhead, sources', () => {
    const p = buildIrSystemPrompt();
    const example = p.slice(p.indexOf('<example>'));

    it('the unsourced coffee example is gone', () => {
        expect(p.toLowerCase()).not.toContain('coffee');
        expect(p).not.toContain('second most traded');
    });
    it('the example IR validates and adds no number that is not in its input', () => {
        const input = example.slice(example.indexOf('Input'), example.indexOf('IR (a bar'));
        const irText = example.slice(example.indexOf('{\n  "schemaVersion"'), example.indexOf('</example>'));
        const parsed = parseIrFromResponse(irText);
        expect(parsed.ok).toBe(true);
        const numbers = (s: string) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);
        const known = numbers(input);
        // schemaVersion, slide ids (s1/s2) and the derived bar lengths are not facts
        const allowed = new Set(['1', '2', '100', '69', String(IR_SCHEMA_VERSION)]);
        const irNumbers = numbers(JSON.stringify(parsed.ok ? parsed.value : {}).replace(/"id":"s\d"/g, ''));
        for (const n of irNumbers) expect(known.has(n) || allowed.has(n)).toBe(true);
        // the bar lengths follow the stated rule: value ÷ largest × 100
        expect(Math.round((4.1 / 5.9) * 100)).toBe(69);
    });
    it('the example shows a subhead, a labelled chart and a source line', () => {
        expect(example).toContain('"kind": "subhead"');
        expect(example).toContain('"axisLabel"');
        expect(example).toContain('"sources"');
    });
    it('documents the subhead block, slide sources/footnotes and the chart blocks the guidance names', () => {
        for (const s of ['"kind": "subhead"', '"sources"?: string[]', '"footnotes"?: string[]', '"kind": "line-chart"', '"kind": "waterfall"', '"kind": "pyramid"']) expect(p).toContain(s);
        expect(p).toContain('WHEN the input names where they come from');
        expect(p).toContain('never invent one');
    });
    it('no longer teaches a bold paragraph as a sub-headline', () => {
        expect(p).not.toContain('"emphasis"?: boolean');
        expect(p).toContain('"subhead" block, not as an emphasised paragraph');
    });
    it('icons: only where they distinguish or sequence, from the registry; the "most should have one" rule is gone', () => {
        expect(p).not.toContain('most cards/steps should have one');
        expect(p).toContain('distinguishes one concept from another');
        expect(p).toContain('not as decoration');
        expect(p).toContain('ONLY names from the <icons> list');
        // every icon the example (or guidance) uses is in the registry
        for (const m of p.matchAll(/"icon"\??: "([a-z-]+)"/g)) expect(isKnownIcon(m[1])).toBe(true);
    });
    it('carries the selection guidance: table vs chart and every message type', () => {
        expect(p).toContain(buildVisualSelectionGuide('ir'));
        for (const s of ['component', 'item comparison', 'time series', 'distribution', 'correlation']) expect(p).toContain(s);
        expect(p).toContain('exact values');
        expect(p).toContain('line-chart');
    });
    it('a sample of each newly documented block validates against the schema', () => {
        const kinds = [...p.matchAll(/\{ "kind": "([a-z-]+)"/g)].map(m => m[1]);
        for (const k of ['subhead', 'waterfall', 'line-chart', 'pyramid']) expect(kinds).toContain(k);
        const sample = deck([content({ blocks: [
            { kind: 'subhead', text: 'Kicker' },
            { kind: 'waterfall', base: { label: 'Start', value: 10 }, deltas: [{ label: 'Up', value: 2 }], total: { label: 'End' } },
            { kind: 'line-chart', series: [{ label: 'A', points: [{ x: '2023', y: 1 }, { x: '2024', y: 2 }] }] },
            { kind: 'pyramid', levels: [{ label: 'Top' }, { label: 'Base', detail: 'wide' }] },
        ] })]);
        expect(validateDeckIr(sample).ok).toBe(true);
    });
});

describe('storyboard prompt — same selection guidance, in its own vocabulary', () => {
    const catalog: EvidenceSpan[] = [{ id: 'e1', source_ref: 'a.md', text: 'x' }];
    it('both prompts embed the shared guide for their stage', () => {
        expect(buildStoryboardPrompt('brief', catalog)).toContain(buildVisualSelectionGuide('storyboard'));
        expect(buildStoryboardRevisionPrompt('{}', 'change', [], catalog)).toContain(buildVisualSelectionGuide('storyboard'));
    });
    it('the two stages describe the same message types and the same table-vs-chart rule', () => {
        const sb = buildVisualSelectionGuide('storyboard').split('\n');
        const ir = buildVisualSelectionGuide('ir').split('\n');
        expect(sb).toHaveLength(ir.length);
        const head = (l: string) => l.split(' → ')[0];
        expect(sb.map(head)).toEqual(ir.map(head));
        expect(sb.join('\n')).toContain('"line"');
        expect(ir.join('\n')).toContain('line-chart');
    });
});
