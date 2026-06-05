/**
 * Brand render context + resolver (plan §5a).
 *
 * ONE contract, all entry points. `resolveBrandRenderContext` is the single
 * service boundary where brand I/O happens (vault read + parse + sanitize +
 * raster); every export path consumes the PRE-RESOLVED `BrandRenderContext`
 * (plain `ExportTheme` + already-rasterized asset data-URIs). The renderers stay
 * synchronous + pure.
 *
 * Returns `Result<BrandRenderContext>` — never throws. Parse warnings travel on
 * the value (`ctx.warnings`).
 */

import type { App } from 'obsidian';
import type { AIOrganiserSettings } from '../../../core/settings';
import { type Result, ok } from '../../../core/result';
import type { ExportTheme } from '../exportTheme';
import { loadBrandTheme } from '../../chat/brandThemeService';
import { toExportTheme } from './brandExportTheme';
import { exampleBrandTheme } from './exampleBrandTheme';
import { getBrandIcon, getBrandFonts, normalizeBrandConcept } from './brandAssets';
import { mapWithConcurrency } from '../../../utils/mapWithConcurrency';

/** Bound on concurrent brand-icon resolution (each concept = 2 file reads +
 *  rasters). Caps simultaneous vault I/O + offscreen raster work (audit M10/M14). */
const ICON_RESOLVE_CONCURRENCY = 6;

export interface ResolvedBrandAssets {
    logoLightPng?: string;
    logoDarkPng?: string;
    /** Per-concept icon data-URIs, BOTH variants resolved (plan G1). */
    icons: Map<string, { lightPng?: string; darkPng?: string }>;
}

export interface BrandRenderContext {
    /** The per-deck On-brand state. */
    enabled: boolean;
    /** Brand theme when enabled+available, else generic-example (on-brand) or
     *  export-settings (off-brand). */
    theme: ExportTheme;
    /** PRE-RESOLVED assets: read + sanitized + rasterized. */
    assets: ResolvedBrandAssets;
    source: 'brand' | 'example' | 'export-settings';
    warnings: string[];
}

function emptyAssets(): ResolvedBrandAssets {
    return { icons: new Map() };
}

/**
 * Resolve the brand render context once, up front, for an export pass.
 *
 * - off-brand → `{ source: 'export-settings', theme: fallbackExportTheme }`, no assets.
 * - on-brand + brand file present → `toExportTheme(loadBrandTheme)` + resolve
 *   both logo variants + icons for `usedConcepts` only (light + dark each).
 * - on-brand + file absent/unreadable → `source: 'example'` (generic shipped
 *   theme) + a warning; no vault assets.
 *
 * `usedConcepts` bounds rasterization to the icons the deck actually references —
 * we never blindly rasterize the whole vault icon folder (plan G1).
 */
export async function resolveBrandRenderContext(
    app: App,
    settings: AIOrganiserSettings,
    brandEnabled: boolean,
    usedConcepts: string[],
    fallbackExportTheme: ExportTheme,
): Promise<Result<BrandRenderContext>> {
    if (!brandEnabled) {
        return ok({
            enabled: false,
            theme: fallbackExportTheme,
            assets: emptyAssets(),
            source: 'export-settings',
            warnings: [],
        });
    }

    const loaded = await loadBrandTheme(app, settings);
    if (!loaded.ok) {
        // On-brand but no readable brand file → generic example + a warning.
        return ok({
            enabled: true,
            theme: toExportTheme(exampleBrandTheme),
            assets: emptyAssets(),
            source: 'example',
            warnings: [`brand file unavailable (${loaded.error}); using example brand`],
        });
    }

    const brand = loaded.value;
    const warnings = [...brand.warnings];
    const theme = toExportTheme(brand);
    const icons = new Map<string, { lightPng?: string; darkPng?: string }>();

    // Brand asset I/O (font embed + icon raster) is wrapped so this service
    // boundary honours its "never throws" contract (audit H1/H3): an asset failure
    // degrades to a warning + the named-font/no-icon fallback, never an escaped
    // rejection. (The individual loaders are already fail-closed; this is a
    // belt-and-braces boundary so a future throwing dependency can't break it.)
    try {
        // Embed brand fonts (woff2 → @font-face) so the preview/PDF render the true
        // brand face. Bind to the bare primary family (`theme.fontFace`).
        const fonts = await getBrandFonts(app, settings, theme.fontFace);
        if (fonts.faceCss) theme.fontFaceCss = fonts.faceCss;
        if (fonts.count === 0 && fonts.skipped.length > 0) {
            warnings.push(`brand fonts present but none embedded (${fonts.skipped.length} skipped); using named font + fallback`);
        }

        // Logo DRAWING is deferred (no renderer consumer yet), so we do NOT resolve
        // + raster the logos here — that work would be wasted (audit M4).

        // Resolve icons for the used concepts only — light + dark each — with
        // bounded concurrency so a concept-heavy deck doesn't fan out unbounded
        // vault reads + offscreen rasters (audit M10/M14).
        const uniqueConcepts = Array.from(
            new Set(usedConcepts.map(normalizeBrandConcept).filter((c) => c.length > 0)),
        );
        await mapWithConcurrency(uniqueConcepts, ICON_RESOLVE_CONCURRENCY, async (concept) => {
            const [lightPng, darkPng] = await Promise.all([
                getBrandIcon(app, settings, concept, 'light'),
                getBrandIcon(app, settings, concept, 'dark'),
            ]);
            if (lightPng || darkPng) {
                icons.set(concept, {
                    ...(lightPng ? { lightPng } : {}),
                    ...(darkPng ? { darkPng } : {}),
                });
            }
        });
    } catch (e) {
        warnings.push(`brand asset resolution degraded: ${e instanceof Error ? e.message : String(e)}`);
    }

    return ok({
        enabled: true,
        theme,
        // logoLightPng/logoDarkPng intentionally absent — logo draw deferred (M4).
        assets: { icons },
        source: 'brand',
        warnings,
    });
}
