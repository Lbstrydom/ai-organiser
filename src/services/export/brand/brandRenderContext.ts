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
import { getBrandIcon, normalizeBrandConcept } from './brandAssets';

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

    // Logo DRAWING is deferred (no renderer consumer yet), so we do NOT resolve +
    // raster the logos here — that work would be wasted (audit M4). The
    // `ResolvedBrandAssets.logoLightPng/logoDarkPng` fields stay optional +
    // undefined so the type is ready when the draw lands.

    // Resolve icons for the used concepts only — light + dark each.
    const icons = new Map<string, { lightPng?: string; darkPng?: string }>();
    const uniqueConcepts = Array.from(
        new Set(usedConcepts.map(normalizeBrandConcept).filter((c) => c.length > 0)),
    );
    await Promise.all(uniqueConcepts.map(async (concept) => {
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
    }));

    return ok({
        enabled: true,
        theme: toExportTheme(brand),
        // logoLightPng/logoDarkPng intentionally absent — logo draw deferred (M4).
        assets: { icons },
        source: 'brand',
        warnings,
    });
}
