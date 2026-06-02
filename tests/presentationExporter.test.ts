/**
 * PresentationExporter.writeHtml (TD-SSR-02 Phase 4).
 *
 * The PPTX paths are thin orchestration over dynamic imports (renderDeckToPptx /
 * dom-to-pptx) + a DOM anchor click — covered by their own suites + the handler
 * routing tests. The HTML-write path owns real logic worth pinning: folder
 * creation, filename sanitisation, and collision-safe pathing.
 */
import { describe, it, expect, vi } from 'vitest';
import { PresentationExporter } from '../src/ui/chat/presentation/presentationExporter';

function makeCtx(existing: string[] = []) {
    const present = new Set(existing);
    const created: { path: string; data: string }[] = [];
    const vault = {
        getAbstractFileByPath: vi.fn((p: string) => (present.has(p) ? { path: p } : null)),
        createFolder: vi.fn(async (p: string) => { present.add(p); }),
        create: vi.fn(async (p: string, data: string) => { created.push({ path: p, data }); present.add(p); }),
    };
    const settings = { presentationOutputFolder: 'Presentations', pluginFolder: 'AI-Organiser' };
    const ctx = { app: { vault }, plugin: { settings }, fullPlugin: { settings } } as never;
    return { ctx, vault, created };
}

const htmlWithTitle = (t: string) => `<html><body><h1>${t}</h1></body></html>`;

describe('PresentationExporter.writeHtml', () => {
    it('writes to {pluginFolder}/{outputFolder}/{title}.html and returns the path', async () => {
        const { ctx, created } = makeCtx();
        const path = await new PresentationExporter().writeHtml(ctx, htmlWithTitle('My Deck'));
        expect(path).toBe('AI-Organiser/Presentations/My Deck.html');
        expect(created[0]).toEqual({ path, data: htmlWithTitle('My Deck') });
    });

    it('creates the output folder when missing', async () => {
        const { ctx, vault } = makeCtx();
        await new PresentationExporter().writeHtml(ctx, htmlWithTitle('Deck'));
        expect(vault.createFolder).toHaveBeenCalledWith('AI-Organiser/Presentations');
    });

    it('sanitises illegal filename characters', async () => {
        const { ctx } = makeCtx();
        const path = await new PresentationExporter().writeHtml(ctx, htmlWithTitle('Q3: Sales/Ops Review?'));
        expect(path).toBe('AI-Organiser/Presentations/Q3- Sales-Ops Review-.html');
    });

    it('appends a numeric suffix on filename collision', async () => {
        const { ctx } = makeCtx([
            'AI-Organiser/Presentations',
            'AI-Organiser/Presentations/Deck.html',
        ]);
        const path = await new PresentationExporter().writeHtml(ctx, htmlWithTitle('Deck'));
        expect(path).toBe('AI-Organiser/Presentations/Deck (1).html');
    });

    it('falls back to "Presentation" when no title is present', async () => {
        const { ctx } = makeCtx();
        const path = await new PresentationExporter().writeHtml(ctx, '<html><body><p>no title</p></body></html>');
        expect(path).toBe('AI-Organiser/Presentations/Presentation.html');
    });
});
