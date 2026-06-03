/**
 * Presentation exporter (TD-SSR-02 Phase 4).
 *
 * Pure export logic extracted from PresentationModeHandler: rich IR→PPTX render
 * with a dom-to-pptx fallback, the transient-anchor file download, and the deck
 * HTML vault write (filename sanitisation + collision-safe path). Takes the deck
 * artifacts + a resolved ExportTheme as inputs; owns NO deck/lifecycle state.
 *
 * The handler keeps the orchestration shell (busy guards, mutationLock, phase,
 * preview/iframe access, user notices) and delegates the actual export here.
 */

import type { ModalContext } from '../ChatModeHandler';
import type { ExportTheme } from '../../../services/export/exportTheme';
import type { SlideDeckIr } from '../../../services/presentationIr/slideIr';
import type { ResolvedBrandAssets } from '../../../services/export/brand/brandRenderContext';
import { extractDeckTitle } from '../../../services/prompts/presentationChatPrompts';
import { logger } from '../../../utils/logger';

export class PresentationExporter {
    /**
     * Build + download a PPTX. Prefers the rich IR path (editable text boxes,
     * tables, notes); falls back to dom-to-pptx (rasterised iframe slides) when
     * the IR is absent or its render yields nothing. Throws on a hard failure
     * so the caller's try/catch surfaces it to the user.
     */
    async exportPptx(opts: {
        html: string;
        deckIr: SlideDeckIr | null;
        theme: ExportTheme;
        allSlides: HTMLElement[];
        ctx: ModalContext;
        /** Pre-resolved brand assets (icons/logo). Threaded into the rich IR
         *  renderer; absent → Lucide-only (unchanged). */
        brandAssets?: ResolvedBrandAssets;
    }): Promise<void> {
        const fileName = sanitizeFileName(extractDeckTitle(opts.html)) + '.pptx';
        const richBuffer = await this.tryRichPptx(opts.deckIr, opts.theme, opts.ctx, opts.brandAssets);
        if (richBuffer) {
            this.downloadBuffer(richBuffer, fileName);
            return;
        }
        // Parser returned zero slides (unexpected HTML shape) or no IR — fall
        // back to the legacy DOM-to-pptx path which rasterises the rendered
        // iframe. Loses editability but ships a usable file. (exportToPptx
        // triggers its own browser download.)
        const { exportToPptx } = await import('dom-to-pptx');
        await exportToPptx(opts.allSlides, { fileName });
    }

    /**
     * Attempt the rich PPTX path: render the IR with pptxgenjs. Returns `null`
     * when there's no IR or the render fails (so the caller falls back to
     * dom-to-pptx). Never throws — failures degrade to the fallback.
     */
    private async tryRichPptx(
        deckIr: SlideDeckIr | null, theme: ExportTheme, ctx: ModalContext,
        brandAssets?: ResolvedBrandAssets,
    ): Promise<ArrayBuffer | null> {
        if (!deckIr) return null;
        try {
            const { renderDeckToPptx } = await import('../../../services/presentationIr');
            const result = await renderDeckToPptx(deckIr, theme, {
                placeholderLabel: ctx.plugin.t.progress.presentation.slideRenderFailed,
                ...(brandAssets ? { brandAssets } : {}),
            });
            if (result.ok) return result.value.buffer;
            logger.warn('Presentation', `IR PPTX render failed: ${result.error}`);
            return null;
        } catch (e) {
            logger.warn('Presentation', `Rich PPTX path failed, will fall back to dom-to-pptx: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    /** Browser download of an ArrayBuffer via a transient anchor click. */
    private downloadBuffer(buffer: ArrayBuffer, fileName: string): void {
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Defer revoke to the next macrotask so the click has landed.
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    /** Write the deck HTML to the vault. Returns the created path. */
    async writeHtml(ctx: ModalContext, html: string): Promise<string> {
        const title = extractDeckTitle(html);
        const folder = getOutputFolder(ctx);
        const fileName = sanitizeFileName(title) + '.html';
        const path = await getAvailablePath(ctx, folder, fileName);
        await ctx.app.vault.create(path, html);
        return path;
    }
}

// ── File utilities (moved verbatim from PresentationModeHandler) ─────────────

function getOutputFolder(ctx: ModalContext): string {
    const sub = ctx.plugin.settings.presentationOutputFolder || 'Presentations';
    return `${ctx.plugin.settings.pluginFolder}/${sub}`;
}

function sanitizeFileName(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, '-').replace(/-+/g, '-').trim() || 'Presentation';
}

async function getAvailablePath(ctx: ModalContext, folder: string, fileName: string): Promise<string> {
    if (!ctx.app.vault.getAbstractFileByPath(folder)) {
        await ctx.app.vault.createFolder(folder);
    }
    const base = `${folder}/${fileName}`;
    if (!ctx.app.vault.getAbstractFileByPath(base)) return base;

    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    for (let i = 1; i < 999; i++) {
        const candidate = `${folder}/${stem} (${i})${ext}`;
        if (!ctx.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return base;
}
