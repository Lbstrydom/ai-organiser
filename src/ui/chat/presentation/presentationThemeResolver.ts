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

import type { ModalContext } from '../ChatModeHandler';
import type { ExportTheme } from '../../../services/export/exportTheme';

export class PresentationThemeResolver {
    private cache: { sig: string; theme: ExportTheme } | null = null;

    async resolve(ctx: ModalContext): Promise<ExportTheme> {
        const s = ctx.fullPlugin.settings;
        const sig = [
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor,
            s.exportFontFace, String(s.exportFontSize),
        ].join('|');
        if (this.cache?.sig === sig) return this.cache.theme;
        const { resolveTheme } = await import('../../../services/export/exportTheme');
        const theme = resolveTheme(
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor, s.exportFontFace, s.exportFontSize,
        );
        this.cache = { sig, theme };
        return theme;
    }
}
