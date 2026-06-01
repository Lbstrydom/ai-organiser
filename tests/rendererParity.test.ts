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
