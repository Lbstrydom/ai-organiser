/**
 * Presentation theme resolver (TD-SSR-02 Phase 4).
 *
 * Resolves the user's ExportTheme — shared by the IR→HTML preview pipeline
 * (generate / refine / polish / scoped-edit) AND the IR→PPTX exporter. Memoised
 * by a signature of the relevant export settings so repeated deck mutations
 * don't re-import + re-resolve on every call; recomputes when a setting changes.
 *
 * Extracted from PresentationModeHandler (was `resolveExportTheme` + its cache,
 * called from 6 sites) so the pipeline and the exporter share one cache instance
 * without either owning the other.
 */

import { TFile } from 'obsidian';
import type { ModalContext } from '../ChatModeHandler';
import type { ExportTheme } from '../../../services/export/exportTheme';
// Single shared brand-folder resolver + guidelines filename (audit M4/M9/M10).
import { getBrandFolder, BRAND_GUIDELINES_FILE } from '../../../services/export/brand/brandAssets';

export class PresentationThemeResolver {
    private cache: { sig: string; theme: ExportTheme } | null = null;

    /**
     * Resolve the `ExportTheme` for the preview + PPTX. When `brandEnabled` AND a
     * brand file is present → the brand-derived theme; else the export-settings
     * theme. The full `BrandRenderContext` (incl. resolved assets) is built by the
     * handler in the renderer task — here we only thread `brandEnabled` so the
     * preview/theme colour+font is brand-correct.
     *
     * SEAM (renderer task): the resolved logo/icon assets are NOT wired here; the
     * handler resolves a `BrandRenderContext` and passes `brandAssets` into the
     * renderers separately. This method owns only the ExportTheme choice.
     */
    async resolve(ctx: ModalContext, brandEnabled: boolean): Promise<ExportTheme> {
        const s = ctx.fullPlugin.settings;
        // Cache key gains brandEnabled + brand-folder mtime so a brand-file edit
        // (or a toggle of the per-deck On-brand state) busts the cached theme.
        const folderPath = getBrandFolder(s);
        // Defensive: some call paths (and tests) provide a stub `app` without a
        // vault — only the brand path needs it, and only when brandEnabled.
        const folderFile = ctx.app?.vault?.getAbstractFileByPath
            ? ctx.app.vault.getAbstractFileByPath(`${folderPath}/${BRAND_GUIDELINES_FILE}`)
            : null;
        const brandMtime = folderFile instanceof TFile ? folderFile.stat.mtime : 0;
        const sig = [
            String(brandEnabled), folderPath, String(brandMtime),
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor,
            s.exportFontFace, String(s.exportFontSize),
            String(s.exportMinFontBody), String(s.exportMinFontCaption), String(s.exportMinFontTable),
        ].join('|');
        if (this.cache?.sig === sig) return this.cache.theme;

        let theme: ExportTheme;
        // Real-app guard (audit M11): brand loading needs a real vault. In stub /
        // test contexts (`ctx.app` without a `vault`), skip the brand path and use
        // the export-settings theme rather than throwing inside `loadBrandTheme`.
        if (brandEnabled && ctx.app?.vault) {
            const { loadBrandTheme } = await import('../../../services/chat/brandThemeService');
            const brand = await loadBrandTheme(ctx.app, s);
            const { toExportTheme } = await import('../../../services/export/brand/brandExportTheme');
            if (brand.ok) {
                theme = toExportTheme(brand.value);
            } else {
                // On-brand but the brand file is missing/unreadable → the generic
                // EXAMPLE brand theme, matching the PPTX exporter's `'example'`
                // source. This keeps the HTML preview and the export in sync
                // (WYSIWYG — audit-Gemini G1); previously the preview fell through
                // to the export-settings theme while the exporter used `example`.
                const { exampleBrandTheme } = await import('../../../services/export/brand/exampleBrandTheme');
                theme = toExportTheme(exampleBrandTheme);
            }
            this.cache = { sig, theme };
            return theme;
        }
        const { resolveTheme } = await import('../../../services/export/exportTheme');
        theme = resolveTheme(
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor, s.exportFontFace, s.exportFontSize,
            s.exportMinFontBody, s.exportMinFontCaption, s.exportMinFontTable,
        );
        this.cache = { sig, theme };
        return theme;
    }
}
