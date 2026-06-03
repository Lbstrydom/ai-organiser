/**
 * Brand asset resolution (plan §6, §9 — NEW `brandAssets.ts`).
 *
 * Resolves vault `999_Brand/` assets — logo (light/dark) + concept-keyed brand
 * icons — into inert PNG data-URIs ready for the pure renderers. All SVGs pass
 * through `sanitizeSvgMarkup` (existing allowlist walker) BEFORE use — fail-closed
 * + size-capped. Absent / unsafe asset → null → caller degrades gracefully
 * (no logo / Lucide fallback).
 *
 * Async + Obsidian I/O lives HERE (vault reads + sanitize + raster); the
 * renderers consume the already-resolved data-URIs synchronously.
 *
 * LRU raster cache keyed by `(kind, fullPath, variant, mtime)` — `fullPath` is
 * the asset file's full normalized vault path (folder + filename) so generic
 * names (`logo`/`icon`) never collide across different brand folders (audit H1);
 * `mtime` is the asset file's `TFile.stat.mtime` (instant, memory-backed, no
 * extra read).
 */

import { type App, TFile, normalizePath } from 'obsidian';
import type { AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { sanitizeSvgMarkup } from '../../../utils/svgSanitize';

export type BrandVariant = 'light' | 'dark';

/** Max bytes for a brand SVG before sanitize/raster — oversized → dropped. */
const MAX_SVG_BYTES = 256 * 1024;

/** Max bytes for a brand PNG before base64 — oversized → dropped (audit H2). */
const MAX_PNG_BYTES = 2_000_000;

/** Bound on the raster LRU. */
const CACHE_CAP = 64;

/** Hard cap on the offscreen SVG raster — a malformed data-URI never resolves
 *  `<img>` onload/onerror, so the raster promise is timed out → null (audit M7). */
const RASTER_TIMEOUT_MS = 5000;

const DEFAULT_BRAND_FOLDER = '999_Brand';

// ── Shared asset filename constants (audit M10) ──────────────────────────────
// Single source so the settings detection matches brandAssets resolution.

/** The brand guidelines markdown file inside the brand folder. */
export const BRAND_GUIDELINES_FILE = 'brand-guidelines.md';
/** Light-variant logo filename (PNG preferred; SVG stopgap). */
export const LOGO_LIGHT = 'logo-light';
/** Dark-variant logo filename (PNG preferred; SVG stopgap). */
export const LOGO_DARK = 'logo-dark';
/** Sub-directory holding brand concept icons. */
export const ICONS_DIR = 'icons';

/**
 * Resolve the brand folder path. The `brandFolderPath` settings field is added
 * by the SETTINGS task — referenced defensively here with a fallback so this
 * module compiles + works before that lands.
 *
 * NOTE: brandFolderPath added by settings task.
 */
export function getBrandFolder(settings: AIOrganiserSettings): string {
    const raw = (settings as AIOrganiserSettings & { brandFolderPath?: string }).brandFolderPath;
    const trimmed = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_BRAND_FOLDER;
    // Folder-path invariant (audit M22): convert Windows backslashes to forward
    // slashes and strip leading/trailing slashes before `normalizePath`, so a
    // user-typed `\999_Brand\` or `/999_Brand/` resolves identically.
    const folder = trimmed.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || DEFAULT_BRAND_FOLDER;
    return normalizePath(folder);
}

/**
 * Normalize a brand-icon concept to a stable lookup key, shared so HTML / IR /
 * PPTX agree (plan M7). Lowercase, trim, collapse whitespace/underscores to
 * single hyphens, strip anything outside `[a-z0-9-]`.
 */
export function normalizeBrandConcept(concept: string): string {
    return (concept ?? '')
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

// ── LRU raster cache ─────────────────────────────────────────────────────────

interface CacheEntry { dataUri: string | null }

/** Map preserves insertion order — re-inserting on hit gives LRU eviction. */
const rasterCache = new Map<string, CacheEntry>();

/** Key by the FULL normalized vault path (folder + filename) — generic names
 *  (`logo`/`icon`) collide across different brand folders otherwise (audit H1).
 *  `recolour` is the resolved ink/white applied before raster — included so a
 *  change to the recolour colour (e.g. `BRAND_ICON_INK`) invalidates a stale
 *  raster cached for the same (kind, path, variant, mtime) (audit M5). Logos pass
 *  an empty recolour (rasterized as-is, no recolour). */
function cacheKey(kind: string, fullPath: string, variant: BrandVariant, mtime: number, recolour: string): string {
    return `${kind}|${normalizePath(fullPath)}|${variant}|${mtime}|${recolour}`;
}

function cacheGet(key: string): CacheEntry | undefined {
    const hit = rasterCache.get(key);
    if (hit) {
        rasterCache.delete(key);
        rasterCache.set(key, hit);
    }
    return hit;
}

function cacheSet(key: string, value: CacheEntry): void {
    rasterCache.set(key, value);
    while (rasterCache.size > CACHE_CAP) {
        const oldest = rasterCache.keys().next().value;
        if (oldest === undefined) break;
        rasterCache.delete(oldest);
    }
}

/** Test/diagnostic hook — clears the module-level raster cache. */
export function clearBrandAssetCache(): void {
    rasterCache.clear();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function getFileAt(app: App, path: string): TFile | null {
    const f = app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
}

/** Base64-encode an ArrayBuffer efficiently — chunked `String.fromCharCode`
 *  over the Uint8Array avoids per-byte string concatenation (audit H2/M12). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000; // 32K — under the arg-count limit for fromCharCode.apply
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

/** Read + sanitize an SVG file → sanitized markup, or null (absent/oversize/unsafe). */
async function readSanitizedSvg(app: App, file: TFile): Promise<string | null> {
    if (file.stat.size > MAX_SVG_BYTES) {
        logger.warn('BrandAssets', `SVG "${file.name}" exceeds ${MAX_SVG_BYTES} bytes — dropped`);
        return null;
    }
    let raw: string;
    try {
        raw = await app.vault.cachedRead(file);
    } catch (e) {
        logger.warn('BrandAssets', `SVG read failed: ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
    let clean: string;
    try {
        clean = sanitizeSvgMarkup(raw);
    } catch (e) {
        // Fail-closed: any sanitizer throw → drop the asset (audit M8/M13:
        // redacted — asset name only, not full content).
        logger.warn('BrandAssets', `SVG sanitize failed for "${file.name}"`, e);
        return null;
    }
    if (!clean) return null;
    return clean;
}

/** Default raster box (px) for brand assets. Logos/icons are placed small in
 *  the deck; 256² gives a crisp result at presentation scale without bloating
 *  the deck. */
const RASTER_PX = 256;

/** Rasterize sanitized SVG markup → PNG data-URI (or null on failure / no DOM).
 *  Injectable for tests (happy-dom has no real canvas raster). */
export type SvgRasterizer = (sanitizedSvg: string) => Promise<string | null>;

/**
 * Default rasterizer — the offscreen `<img>`→`<canvas>`→`toDataURL` pattern from
 * `slideThumbnailProvider.ts`.
 *
 * SAFETY: the SVG is ALREADY sanitized (`sanitizeSvgMarkup` — no scripts /
 * external refs / `<foreignObject>`) and is loaded as an `<img>`, which never
 * executes scripts and (post-sanitize) references no external sub-resources — so
 * the canvas stays un-tainted and the raster is fully inert.
 *
 * Async + DOM-bound; fails CLOSED (returns null) without a DOM, on load failure,
 * or on a tainted canvas.
 */
const defaultRasterize: SvgRasterizer = async (sanitizedSvg) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sanitizedSvg);
    const img = new Image();
    // Timeout (audit M7): a malformed data-URI may never fire onload/onerror —
    // resolve null after RASTER_TIMEOUT_MS so the raster never hangs forever.
    const loaded = await new Promise<boolean>((res) => {
        const finish = (ok: boolean) => {
            clearTimeout(timer);
            img.onload = null;
            img.onerror = null;
            res(ok);
        };
        const timer = setTimeout(() => finish(false), RASTER_TIMEOUT_MS);
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = svgUrl;
    });
    if (!loaded) {
        logger.warn('Brand', 'SVG raster load failed or timed out');
        return null;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = RASTER_PX;
        canvas.height = RASTER_PX;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, RASTER_PX, RASTER_PX);
        return canvas.toDataURL('image/png'); // throws if tainted
    } catch (e) {
        logger.warn('Brand', 'SVG raster draw/encode failed', e);
        return null;
    }
};

let activeRasterizer: SvgRasterizer = defaultRasterize;

/** Test seam — swap the SVG→PNG rasterizer (and restore via the returned fn). */
export function setBrandSvgRasterizer(r: SvgRasterizer | null): () => void {
    const prev = activeRasterizer;
    activeRasterizer = r ?? defaultRasterize;
    return () => { activeRasterizer = prev; };
}

/** Raster a sanitized SVG → PNG data-URI, degrading to null on any failure
 *  (file contract). Wraps `activeRasterizer` in try/catch + diagnostics (audit
 *  M8/M13 — redacted: asset name only). */
async function svgToImageDataUri(sanitizedSvg: string, assetName: string): Promise<string | null> {
    try {
        return await activeRasterizer(sanitizedSvg);
    } catch (e) {
        logger.warn('Brand', `SVG raster failed for "${assetName}"`, e);
        return null;
    }
}

/**
 * Recolour a single-colour (line/glyph) SVG before raster so an icon reads on
 * its slide background: `dark` variant → brand ink (for light backgrounds),
 * `light` variant → white (for dark backgrounds). Operates on the SANITIZED
 * markup string (string-replace of explicit `fill`/`stroke`/`currentColor`),
 * which is sufficient for the curated single-colour starter set.
 *
 * TODO(brand): this is a string-level recolour for single-colour line icons. A
 * multi-colour brand glyph would need a DOM walk to recolour selectively — out
 * of scope for the curated starter set, which is single-ink by design.
 */
function recolourIconSvg(sanitizedSvg: string, variant: BrandVariant): string {
    const ink = iconInk(variant);
    return sanitizedSvg
        .replace(/currentColor/gi, ink)
        .replace(/(\b(?:fill|stroke)\s*=\s*)(["'])(?!none\2)[^"']*\2/gi, `$1$2${ink}$2`);
}

/** Ink used for the `dark` icon variant (on light backgrounds). Neutral dark —
 *  the renderer chooses the variant by slide background, not by brand palette. */
const BRAND_ICON_INK = '#1A1A2E';

/** Resolved recolour ink for an icon variant: `light` → white (dark backgrounds),
 *  `dark` → brand ink (light backgrounds). Shared by `recolourIconSvg` and the
 *  cache key so the cached raster is keyed by the colour actually applied. */
function iconInk(variant: BrandVariant): string {
    return variant === 'light' ? '#FFFFFF' : BRAND_ICON_INK;
}

function pngDataUri(base64: string): string {
    return `data:image/png;base64,${base64}`;
}

// ── Logo resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the brand logo for a variant → PNG data-URI (or SVG stopgap), or null.
 *
 * Looks for `999_Brand/logo-<variant>.png` first; if only `logo-<variant>.svg`
 * exists, sanitize + rasterize it. Absent → null.
 */
export async function getLogo(
    app: App,
    settings: AIOrganiserSettings,
    variant: BrandVariant,
): Promise<string | null> {
    const folder = getBrandFolder(settings);

    const logoName = variant === 'light' ? LOGO_LIGHT : LOGO_DARK;

    const pngFile = getFileAt(app, `${folder}/${logoName}.png`);
    if (pngFile) {
        // Logos are rasterized as-is (no recolour) → empty recolour segment.
        const key = cacheKey('logo', pngFile.path, variant, pngFile.stat.mtime, '');
        const cached = cacheGet(key);
        if (cached) return cached.dataUri;
        let dataUri: string | null = null;
        // Size cap (audit H2): refuse oversized PNGs before readBinary + base64.
        if (pngFile.stat.size > MAX_PNG_BYTES) {
            logger.warn('Brand', `logo PNG "${pngFile.name}" exceeds ${MAX_PNG_BYTES} bytes — dropped`);
        } else {
            try {
                const buf = await app.vault.readBinary(pngFile);
                dataUri = pngDataUri(arrayBufferToBase64(buf));
            } catch (e) {
                logger.warn('Brand', `logo PNG read failed for "${pngFile.name}"`, e);
                dataUri = null;
            }
        }
        cacheSet(key, { dataUri });
        return dataUri;
    }

    const svgFile = getFileAt(app, `${folder}/${logoName}.svg`);
    if (svgFile) {
        const key = cacheKey('logo', svgFile.path, variant, svgFile.stat.mtime, '');
        const cached = cacheGet(key);
        if (cached) return cached.dataUri;
        const clean = await readSanitizedSvg(app, svgFile);
        // Logos are multi-colour brand marks — rasterized as-is (no recolour).
        const dataUri = clean ? await svgToImageDataUri(clean, svgFile.name) : null;
        cacheSet(key, { dataUri });
        return dataUri;
    }

    return null;
}

// ── Icon resolution ──────────────────────────────────────────────────────────

interface IconManifest { [concept: string]: string }

let manifestCache: { mtime: number; map: IconManifest } | null = null;

/** Load the optional `999_Brand/icons/manifest.json` (`{concept: file}`). */
async function loadManifest(app: App, folder: string): Promise<IconManifest> {
    const file = getFileAt(app, `${folder}/${ICONS_DIR}/manifest.json`);
    if (!file) { manifestCache = null; return {}; }
    if (manifestCache && manifestCache.mtime === file.stat.mtime) return manifestCache.map;
    try {
        const raw = await app.vault.cachedRead(file);
        const parsed = JSON.parse(raw) as unknown;
        const map: IconManifest = {};
        if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof v === 'string') map[normalizeBrandConcept(k)] = v;
            }
        }
        manifestCache = { mtime: file.stat.mtime, map };
        return map;
    } catch (e) {
        logger.warn('BrandAssets', `icon manifest parse failed: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }
}

/**
 * Resolve a brand icon for a concept + variant → PNG data-URI (or SVG stopgap),
 * or null. Manifest lookup first (`{concept: file}`), else direct
 * `icons/<concept>.svg`. Sanitized + size-capped; absent/unsafe → null.
 *
 * The `variant` drives the cache key + the raster colour choice: `dark` → brand
 * ink (light backgrounds), `light` → white (dark backgrounds). The source SVG is
 * shared (single-colour glyph); `recolourIconSvg` applies the variant ink before
 * raster.
 */
export async function getBrandIcon(
    app: App,
    settings: AIOrganiserSettings,
    concept: string,
    variant: BrandVariant,
): Promise<string | null> {
    const folder = getBrandFolder(settings);
    const key = normalizeBrandConcept(concept);
    if (!key) return null;

    const manifest = await loadManifest(app, folder);
    const mappedFile = manifest[key];
    const candidatePath = mappedFile
        ? `${folder}/${ICONS_DIR}/${mappedFile}`
        : `${folder}/${ICONS_DIR}/${key}.svg`;

    const file = getFileAt(app, candidatePath);
    if (!file) return null;

    // Include the resolved recolour ink so a stale raster never survives an ink
    // change for the same (path, variant, mtime) (audit M5).
    const cKey = cacheKey('icon', file.path, variant, file.stat.mtime, iconInk(variant));
    const cached = cacheGet(cKey);
    if (cached) return cached.dataUri;

    const clean = await readSanitizedSvg(app, file);
    // Recolour the single-colour glyph for the slide-background variant, then raster.
    const dataUri = clean ? await svgToImageDataUri(recolourIconSvg(clean, variant), file.name) : null;
    cacheSet(cKey, { dataUri });
    return dataUri;
}
