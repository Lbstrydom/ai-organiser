// @vitest-environment happy-dom
/**
 * Renderer parity — the guardrail that keeps preview (irToHtml) == export
 * (irToPptx). For each shared decision, assert that EACH renderer's actual
 * emitted output reflects the same `IR_RENDER_SPEC` value (not merely that the
 * helper returns it). Plan: presentation-renderer-fidelity.md (D5).
 *
 * Grows per implementation stage: P1 covers #1 table header / #2 accent motif /
 * #3 title alignment; P2 adds gradient + icon parity; P3 adds stat sizing +
 * callout stripe.
 */
import { describe, it, expect } from 'vitest';
import { renderDeckToHtml } from '../src/services/presentationIr/irToHtml';
import { renderDeckToPptx } from '../src/services/presentationIr/irToPptx';
import { IR_RENDER_SPEC, PX_PER_IN } from '../src/services/presentationIr/irRenderSpec';
import { CANVAS } from '../src/services/presentationIr/irLayout';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';
import { resolveTheme } from '../src/services/export/exportTheme';

const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);
const primaryHex = theme.primaryColor.replace('#', '').toUpperCase();
const accentHex = theme.accentColor.replace('#', '').toUpperCase();

// ── Capturing pptxgenjs stub ─────────────────────────────────────────────────
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
async function pptxSlides(deck: SlideDeckIr): Promise<CapSlide[]> {
    const instances: CapPptx[] = [];
    class Wrapped extends CapPptx { constructor() { super(); instances.push(this); } }
    const r = await renderDeckToPptx(deck, theme, { pptxModule: Wrapped as unknown as never });
    expect(r.ok).toBe(true);
    return instances[0]?.slides ?? [];
}
function html(deck: SlideDeckIr): string {
    const r = renderDeckToHtml(deck, theme);
    expect(r.ok).toBe(true);
    return r.ok ? r.value.html : '';
}

const deck = (slides: SlideDeckIr['slides']): SlideDeckIr =>
    ({ schemaVersion: IR_SCHEMA_VERSION, title: 'Parity', slides });

describe('parity #3 — hero title alignment (left in both)', () => {
    const d = deck([{ id: 's1', type: 'title', title: 'Hero', subtitle: 'Sub', blocks: [] }]);
    it('HTML hero is left-aligned (flex-start)', () => {
        expect(html(d)).toContain('align-items:flex-start');
    });
    it('PPTX hero title uses the spec align', async () => {
        const [s] = await pptxSlides(d);
        const titleCall = s.calls.find(c => c.method === 'addText' && c.args[0] === 'Hero');
        expect(titleCall).toBeDefined();
        expect((titleCall!.args[1] as { align: string }).align).toBe(IR_RENDER_SPEC.titleLayout.align);
    });
});

describe('parity #1 — table header fill (primary in both, not accent)', () => {
    const d = deck([{
        id: 's1', type: 'content', title: 'T', blocks: [
            { kind: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
        ],
    }]);
    it('HTML <th> uses primary, not accent', () => {
        const out = html(d);
        const th = out.slice(out.indexOf('<th'));
        expect(th.toUpperCase()).toContain(`BACKGROUND:#${primaryHex}`);
        expect(th.toUpperCase()).not.toContain(`BACKGROUND:#${accentHex}`);
    });
    it('PPTX table header cell fill is primary, not accent', async () => {
        const [s] = await pptxSlides(d);
        const table = s.calls.find(c => c.method === 'addTable');
        expect(table).toBeDefined();
        const rows = table!.args[0] as Array<Array<{ options?: { fill?: { color?: string } } }>>;
        const headerFill = rows[0][0].options?.fill?.color?.toUpperCase();
        expect(headerFill).toBe(primaryHex);
        expect(headerFill).not.toBe(accentHex);
    });
    it('both reflect IR_RENDER_SPEC.tableHeaderFill', () => {
        expect(IR_RENDER_SPEC.tableHeaderFill(theme).replace('#', '').toUpperCase()).toBe(primaryHex);
    });
});

describe('parity #4 — hero gradient in both; content solid in both', () => {
    const hero = deck([{ id: 's1', type: 'title', title: 'Hero', blocks: [] }]);
    const content = deck([{ id: 's1', type: 'content', title: 'C', blocks: [{ kind: 'paragraph', text: 'x' }] }]);
    it('HTML hero uses a linear-gradient backdrop', () => {
        expect(html(hero)).toContain('linear-gradient(135deg');
    });
    it('PPTX hero draws the gradient image FIRST (draw-order), before the title', async () => {
        const [s] = await pptxSlides(hero);
        expect(s.calls[0]?.method).toBe('addImage');
        const firstText = s.calls.findIndex(c => c.method === 'addText');
        expect(s.calls.findIndex(c => c.method === 'addImage')).toBeLessThan(firstText);
    });
    it('content slide is solid (no gradient image, white HTML bg)', async () => {
        expect(html(content)).not.toContain('linear-gradient');
        const [s] = await pptxSlides(content);
        expect(s.calls.some(c => c.method === 'addImage')).toBe(false);
    });
});

describe('parity #5 — vector icons, symmetric presence', () => {
    const withIcon = deck([{
        id: 's1', type: 'content', title: 'C',
        blocks: [{ kind: 'stat-grid', cards: [{ value: '9', label: 'L', icon: 'trending-up' }] }],
    }]);
    const unknownIcon = deck([{
        id: 's1', type: 'content', title: 'C',
        blocks: [{ kind: 'stat-grid', cards: [{ value: '9', label: 'L', icon: 'totally-unknown' }] }],
    }]);
    it('known icon → SVG in HTML AND an image in PPTX', async () => {
        expect(html(withIcon)).toContain('<svg');
        const [s] = await pptxSlides(withIcon);
        expect(s.calls.some(c => c.method === 'addImage')).toBe(true);
    });
    it('unknown icon → absent in BOTH (symmetric)', async () => {
        expect(html(unknownIcon)).not.toContain('<svg');
        const [s] = await pptxSlides(unknownIcon);
        expect(s.calls.some(c => c.method === 'addImage')).toBe(false);
    });
});

describe('parity #6 — callout left stripe in both', () => {
    const d = deck([{ id: 's1', type: 'content', title: 'C', blocks: [{ kind: 'callout', text: 'note' }] }]);
    const stripeW = IR_RENDER_SPEC.calloutStripe.widthIn;
    it('HTML callout has a left accent border', () => {
        expect(html(d)).toContain(`border-left:${Math.round(stripeW * PX_PER_IN)}px solid`);
    });
    it('PPTX callout draws a thin left stripe rect', async () => {
        const [s] = await pptxSlides(d);
        const rects = s.calls.filter(c => c.method === 'addShape' && c.args[0] === 'rect')
            .map(c => c.args[1] as { w: number });
        expect(rects.some(r => Math.abs(r.w - stripeW) < 0.001)).toBe(true);
    });
});

describe('parity #2 — accent motif is an underline, not a top bar', () => {
    const d = deck([{ id: 's1', type: 'content', title: 'Titled', blocks: [{ kind: 'paragraph', text: 'x' }] }]);
    const uW = IR_RENDER_SPEC.accentUnderline.widthIn;
    it('HTML draws the short underline (≈130px), no full-width bar', () => {
        const out = html(d);
        expect(out).toContain(`width:${Math.round(uW * PX_PER_IN)}px`);   // 130px underline
    });
    it('PPTX draws the underline rect and NOT the old full-width top bar', async () => {
        const [s] = await pptxSlides(d);
        const rects = s.calls.filter(c => c.method === 'addShape' && c.args[0] === 'rect')
            .map(c => c.args[1] as { x: number; y: number; w: number; h: number });
        // underline present: a rect at left margin with the spec width
        expect(rects.some(r => Math.abs(r.w - uW) < 0.01)).toBe(true);
        // old top bar gone: no full-canvas-width 0.08-high bar at y=0
        expect(rects.some(r => Math.abs(r.w - CANVAS.w) < 0.01 && r.y === 0)).toBe(false);
    });
});

// ── Phase 2 (renderer-fidelity): typography + geometry SSOT parity ───────────
// Both renderers derive every font/geometry value from IR_RENDER_SPEC, so a
// drift is a failing assertion. HTML px == ptToPx/inToPx(spec) == PPTX value.
import { ptToPx, inToPx } from '../src/services/presentationIr/irRenderSpec';

function fontSizesOf(s: CapSlide): number[] {
    return s.calls
        .filter(c => c.method === 'addText')
        .map(c => (c.args[1] as { fontSize?: number })?.fontSize)
        .filter((n): n is number => typeof n === 'number');
}

describe('parity — typography SSOT (font sizes match across preview/export)', () => {
    it('hero title: HTML px == ptToPx(heroTitlePt) and PPTX pt == heroTitlePt', async () => {
        const d = deck([{ id: 's1', type: 'title', title: 'Hero', blocks: [] }]);
        expect(html(d)).toContain(`font-size:${ptToPx(IR_RENDER_SPEC.font.heroTitlePt)}px`);
        const [s] = await pptxSlides(d);
        expect(fontSizesOf(s)).toContain(IR_RENDER_SPEC.font.heroTitlePt);
    });
    it('section title uses sectionTitlePt in both', async () => {
        const d = deck([{ id: 's1', type: 'section', title: 'Sec', blocks: [] }]);
        expect(html(d)).toContain(`font-size:${ptToPx(IR_RENDER_SPEC.font.sectionTitlePt)}px`);
        const [s] = await pptxSlides(d);
        expect(fontSizesOf(s)).toContain(IR_RENDER_SPEC.font.sectionTitlePt);
    });
    it('content title: HTML px == ptToPx(slideTitlePt) and PPTX pt == slideTitlePt', async () => {
        const d = deck([{ id: 's1', type: 'content', title: 'Titled', blocks: [{ kind: 'paragraph', text: 'x' }] }]);
        expect(html(d)).toContain(`font-size:${ptToPx(IR_RENDER_SPEC.font.slideTitlePt)}px`);
        const [s] = await pptxSlides(d);
        expect(fontSizesOf(s)).toContain(IR_RENDER_SPEC.font.slideTitlePt);
    });
    it('stat label (floored structural font): HTML px == ptToPx(statLabelPt) and PPTX pt matches', async () => {
        const d = deck([{ id: 's1', type: 'content', blocks: [{ kind: 'stat-grid', cards: [{ value: '9', label: 'L' }] }] }]);
        const pt = IR_RENDER_SPEC.font.statLabelPt(theme);
        expect(html(d)).toContain(`font-size:${ptToPx(pt)}px`);
        const [s] = await pptxSlides(d);
        expect(fontSizesOf(s)).toContain(pt);
    });
});

describe('parity — geometry SSOT (radii match across preview/export)', () => {
    it('stat card radius: HTML px == inToPx(cardRadiusIn) and PPTX in == cardRadiusIn', async () => {
        const d = deck([{ id: 's1', type: 'content', blocks: [{ kind: 'stat-grid', cards: [{ value: '9', label: 'L' }] }] }]);
        expect(html(d)).toContain(`border-radius:${inToPx(IR_RENDER_SPEC.geometry.cardRadiusIn)}px`);
        const [s] = await pptxSlides(d);
        const radii = s.calls
            .filter(c => c.method === 'addShape' && c.args[0] === 'roundRect')
            .map(c => (c.args[1] as { rectRadius?: number }).rectRadius);
        expect(radii).toContain(IR_RENDER_SPEC.geometry.cardRadiusIn);
    });
});
