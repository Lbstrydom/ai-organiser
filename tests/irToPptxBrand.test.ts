// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderDeckToPptx } from '../src/services/presentationIr/irToPptx';
import { CANVAS } from '../src/services/presentationIr/irLayout';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';
import { resolveTheme, type ExportTheme, type ExportMinFont, type ExportSafeArea } from '../src/services/export/exportTheme';
import type { ResolvedBrandAssets } from '../src/services/export/brand/brandRenderContext';

const baseTheme = resolveTheme('navy-gold', '', '', 'Inter', 14);

const MIN_FONT: ExportMinFont = { body: 16, caption: 14, table: 15, footer: 11 };
const SAFE_AREA: ExportSafeArea = {
    headerBandIn: 1.0, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25,
};

function brandTheme(over: Partial<ExportTheme> = {}): ExportTheme {
    return { ...baseTheme, minFont: MIN_FONT, safeArea: SAFE_AREA, ...over };
}

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
    addNotes() { /* notes pane */ }
    textOpts(): Array<Record<string, unknown>> {
        return this.calls.filter(c => c.method === 'addText').map(c => c.args[1] as Record<string, unknown>);
    }
    imageOpts(): Array<Record<string, unknown>> {
        return this.calls.filter(c => c.method === 'addImage').map(c => c.args[0] as Record<string, unknown>);
    }
}
class CapPptx {
    layout = '';
    slides: CapSlide[] = [];
    addSlide() { const s = new CapSlide(); this.slides.push(s); return s; }
    async write() { return new ArrayBuffer(32); }
}

async function render(deck: SlideDeckIr, theme: ExportTheme, opts: Record<string, unknown> = {}) {
    const instances: CapPptx[] = [];
    class Wrapped extends CapPptx { constructor() { super(); instances.push(this); } }
    const r = await renderDeckToPptx(deck, theme, { pptxModule: Wrapped as unknown as never, ...opts });
    return { r, slides: instances[0]?.slides ?? [] };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const statDeck: SlideDeckIr = {
    schemaVersion: IR_SCHEMA_VERSION,
    slides: [{
        id: 's1', type: 'content', title: 'Stats',
        blocks: [{
            kind: 'stat-grid',
            cards: [
                { value: '10', label: 'Alpha', icon: 'trending-up' },
                { value: '20', label: 'Beta', icon: 'leaf' },
            ],
        }],
    }],
};

const fullDeck: SlideDeckIr = {
    schemaVersion: IR_SCHEMA_VERSION,
    slides: [
        { id: 't', type: 'title', title: 'Title', subtitle: 'Sub', blocks: [] },
        { id: 'sec', type: 'section', title: 'Section', blocks: [] },
        { id: 'c', type: 'content', title: 'Content', blocks: [{ kind: 'paragraph', text: 'Body text here.' }] },
        { id: 'end', type: 'closing', title: 'Thanks', blocks: [] },
    ],
};

const fontSizes = (slide: CapSlide): number[] =>
    slide.textOpts().map(o => o.fontSize as number).filter(n => typeof n === 'number');

describe('irToPptx — min-font floor (plan §5 H4)', () => {
    it('no addText drops below the per-role floor when minFont is set', async () => {
        const { slides } = await render(statDeck, brandTheme());
        const floor = Math.min(MIN_FONT.body, MIN_FONT.caption, MIN_FONT.table, MIN_FONT.footer);
        for (const s of slides) {
            for (const size of fontSizes(s)) expect(size).toBeGreaterThanOrEqual(floor);
        }
    });

    it('stat label (fixed 11pt) clamps UP to the caption floor', async () => {
        const { slides } = await render(statDeck, brandTheme());
        const labels = slides[0].textOpts().filter(o => o.align === 'center' && o.valign === 'top');
        expect(labels.length).toBeGreaterThan(0);
        for (const l of labels) expect(l.fontSize as number).toBeGreaterThanOrEqual(MIN_FONT.caption);
    });

    it('output is byte-identical (same font sizes) when minFont is undefined', async () => {
        const withFloor = await render(statDeck, baseTheme);          // no minFont
        const same = await render(statDeck, baseTheme);
        expect(fontSizes(withFloor.slides[0])).toEqual(fontSizes(same.slides[0]));
        // And every fixed literal stays at its original value (e.g. 11 for labels).
        const labels = withFloor.slides[0].textOpts().filter(o => o.align === 'center' && o.valign === 'top');
        for (const l of labels) expect(l.fontSize).toBe(11);
    });

    it('a higher floor raises the literal; an equal/lower floor leaves it unchanged', async () => {
        const high = await render(statDeck, brandTheme({ minFont: { body: 22, caption: 20, table: 15, footer: 11 } }));
        const labelsHigh = high.slides[0].textOpts().filter(o => o.align === 'center' && o.valign === 'top');
        for (const l of labelsHigh) expect(l.fontSize).toBe(20);   // 11 clamped up to 20

        const low = await render(statDeck, brandTheme({ minFont: { body: 5, caption: 5, table: 5, footer: 5 } }));
        const labelsLow = low.slides[0].textOpts().filter(o => o.align === 'center' && o.valign === 'top');
        for (const l of labelsLow) expect(l.fontSize).toBe(11);    // floor below literal → unchanged
    });
});

describe('irToPptx — safe-area geometry (plan §7)', () => {
    it('content slide blocks start at contentTopIn and inset the right by logoReserveIn', async () => {
        const { slides } = await render(fullDeck, brandTheme());
        // Slide index 2 = content. The body paragraph is the addText after the title.
        const content = slides[2];
        const bodyText = content.textOpts().find(o => o.color !== undefined && (o.y as number) >= SAFE_AREA.contentTopIn - 1e-9);
        expect(bodyText).toBeDefined();
        expect(bodyText!.y as number).toBeGreaterThanOrEqual(SAFE_AREA.contentTopIn - 1e-9);
        // width = canvas - sideMargin*2 - logoReserve (content carries the logo).
        const expectedW = CANVAS.w - SAFE_AREA.sideMarginIn * 2 - SAFE_AREA.logoReserveIn;
        expect(bodyText!.w as number).toBeCloseTo(expectedW, 5);
        expect(bodyText!.x as number).toBeCloseTo(SAFE_AREA.sideMarginIn, 5);
    });

    it('section/closing reserve NO logo (full width minus side margins only)', async () => {
        const { slides } = await render(fullDeck, brandTheme());
        const sectionTitle = slides[1].textOpts()[0];   // hero title
        const expectedW = CANVAS.w - SAFE_AREA.sideMarginIn * 2;   // no logo reserve
        expect(sectionTitle.w as number).toBeCloseTo(expectedW, 5);
        const closingTitle = slides[3].textOpts()[0];
        expect(closingTitle.w as number).toBeCloseTo(expectedW, 5);
    });

    it('title slide DOES reserve the logo (narrower than section)', async () => {
        const { slides } = await render(fullDeck, brandTheme());
        const titleW = slides[0].textOpts()[0].w as number;
        const sectionW = slides[1].textOpts()[0].w as number;
        expect(titleW).toBeLessThan(sectionW);
        expect(titleW).toBeCloseTo(CANVAS.w - SAFE_AREA.sideMarginIn * 2 - SAFE_AREA.logoReserveIn, 5);
    });

    it('geometry is unchanged (default constants) when safeArea is undefined', async () => {
        const withSA = await render(fullDeck, baseTheme);           // no safeArea
        // default content top = 1.3; default left = 0.5; default width = 12.33.
        const body = withSA.slides[2].textOpts().find(o => (o.y as number) >= 1.3 - 1e-9 && o.color !== undefined);
        expect(body).toBeDefined();
        expect(body!.x as number).toBeCloseTo(0.5, 5);
        expect(body!.w as number).toBeCloseTo(CANVAS.w - 1.0, 5);   // 12.33
    });
});

describe('irToPptx — brand asset icons (plan §5a G2 / §6)', () => {
    function assets(concepts: string[]): ResolvedBrandAssets {
        const icons = new Map<string, { lightPng?: string; darkPng?: string }>();
        for (const c of concepts) {
            icons.set(c, { lightPng: 'data:image/png;base64,LIGHT', darkPng: 'data:image/png;base64,DARK' });
        }
        return { icons };
    }

    it('uses the brand PNG (dark variant on a light content bg) when the concept is present', async () => {
        const { slides } = await render(statDeck, brandTheme(), { brandAssets: assets(['trending-up', 'leaf']) });
        const imgs = slides[0].imageOpts().map(o => o.data as string);
        // Both icon concepts → brand dark PNGs (content slide bg is light).
        expect(imgs.filter(d => d === 'data:image/png;base64,DARK').length).toBe(2);
        expect(imgs).not.toContain('data:image/png;base64,LIGHT');
    });

    it('falls back to the Lucide SVG icon when the concept is absent from brandAssets', async () => {
        const { slides } = await render(statDeck, brandTheme(), { brandAssets: assets(['trending-up']) });
        const imgs = slides[0].imageOpts().map(o => o.data as string);
        // leaf is NOT in brand assets → Lucide SVG data-URI (not the brand PNG).
        expect(imgs.some(d => d === 'data:image/png;base64,DARK')).toBe(true);   // trending-up brand
        expect(imgs.some(d => typeof d === 'string' && d.startsWith('data:image/svg+xml'))).toBe(true); // leaf Lucide
    });

    it('with no brandAssets, every icon is the Lucide SVG path (unchanged)', async () => {
        const { slides } = await render(statDeck, brandTheme());
        const imgs = slides[0].imageOpts().map(o => o.data as string);
        expect(imgs.every(d => typeof d === 'string' && d.startsWith('data:image/svg+xml'))).toBe(true);
        expect(imgs.some(d => (d as string).includes('base64,DARK'))).toBe(false);
    });
});
