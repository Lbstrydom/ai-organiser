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

import { type App, TFile, TFolder, normalizePath } from 'obsidian';
import type { AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import { sanitizeSvgMarkup } from '../../../utils/svgSanitize';
import { serializeCssFontFamily, coerceFontWeight, coerceFontStyle } from '../../presentationIr/themeSafe';

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
/** Sub-directory holding brand web fonts (woff2) embedded into the preview/PDF. */
export const FONTS_DIR = 'fonts';

// ── Font embedding constants (brand-font-embedding R3-L1: exact, not approx) ──
/** Max bytes for a single font file before base64 — oversized → dropped. */
const MAX_FONT_BYTES = 2 * 1024 * 1024;
/** Total embedded-font budget across all faces — bounds the inlined HTML/PDF. */
const MAX_TOTAL_FONT_BYTES = 8 * 1024 * 1024;
/** Cap on RETAINED assembled-CSS chars in the font cache (`.length` accounting). */
const MAX_FONT_CSS_CACHE_CHARS = 12 * 1024 * 1024;
/** Cap on font-cache entries. */
const MAX_FONT_CSS_CACHE_ENTRIES = 4;
/** woff2 signature `wOF2` — first 4 bytes of every woff2 file. */
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32] as const;

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

/** Test/diagnostic hook — clears the module-level raster cache AND the font CSS
 *  cache (Gemini-R1-L1: one reset helper resets both, so tests can't forget). */
export function clearBrandAssetCache(): void {
    rasterCache.clear();
    fontCssCache.clear();
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

// ── Font resolution (brand-font-embedding) ───────────────────────────────────

/** Lightweight status — folder state + candidate count (settings status line). */
export interface BrandFontStatus {
    folderState: 'absent' | 'empty' | 'present';
    /** In-budget `.woff2` candidates (stat-only — NOT magic-validated). */
    count: number;
    /** Filenames skipped at the stat level (oversize), for the status caption. */
    skipped: string[];
}

/** Heavy embed result — assembled `@font-face` CSS + counts. Plain object (matches
 *  the sibling `getLogo`/`getBrandIcon` return convention, NOT `Result<T>`);
 *  `skipped[]` carries per-file drop reasons for observability (audit R1-L2). */
export interface BrandFontsResult {
    faceCss: string;
    count: number;
    skipped: string[];
}

const EMPTY_FONTS: BrandFontsResult = { faceCss: '', count: 0, skipped: [] };

/** Assembled-font-CSS cache: byte-bounded (chars) + entry-bounded LRU (R2-M2). */
interface FontCacheEntry { value: BrandFontsResult; chars: number }
const fontCssCache = new Map<string, FontCacheEntry>();
let fontCssCacheChars = 0;

function fontCacheGet(key: string): BrandFontsResult | undefined {
    const hit = fontCssCache.get(key);
    if (!hit) return undefined;
    fontCssCache.delete(key);
    fontCssCache.set(key, hit);
    return hit.value;
}

function fontCacheSet(key: string, value: BrandFontsResult): void {
    const chars = value.faceCss.length;
    // An entry larger than the whole budget is returned but not cached.
    if (chars > MAX_FONT_CSS_CACHE_CHARS) return;
    while (
        (fontCssCache.size >= MAX_FONT_CSS_CACHE_ENTRIES || fontCssCacheChars + chars > MAX_FONT_CSS_CACHE_CHARS)
        && fontCssCache.size > 0
    ) {
        const oldestKey = fontCssCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = fontCssCache.get(oldestKey);
        fontCssCache.delete(oldestKey);
        if (oldest) fontCssCacheChars -= oldest.chars;
    }
    fontCssCache.set(key, { value, chars });
    fontCssCacheChars += chars;
}

function getFontsFolder(app: App, settings: AIOrganiserSettings): { path: string; dir: TFolder | null } {
    const path = normalizePath(`${getBrandFolder(settings)}/${FONTS_DIR}`);
    const dir = app.vault.getAbstractFileByPath(path);
    return { path, dir: dir instanceof TFolder ? dir : null };
}

/** Woff2 files in the fonts folder, sorted by normalized path (deterministic
 *  CSS order — audit L1). */
function listFontFiles(dir: TFolder): TFile[] {
    return dir.children
        .filter((f): f is TFile => f instanceof TFile && /\.woff2$/i.test(f.name))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/** Derive `{weight, style}` from a font filename (`<slug>-<weight>[-italic].woff2`).
 *  Unmatched → 400 / normal. */
function parseFaceFromName(name: string): { weight: number; style: 'normal' | 'italic' | 'oblique' } {
    const base = name.replace(/\.woff2$/i, '');
    const italic = /(?:^|-)(italic|oblique)$/i.test(base);
    const weightMatch = /(?:^|-)(\d{3,4})(?:-(?:italic|oblique))?$/i.exec(base);
    return {
        weight: coerceFontWeight(weightMatch ? weightMatch[1] : 400),
        style: italic ? 'italic' : 'normal',
    };
}

function hasWoff2Magic(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 4) return false;
    const b = new Uint8Array(buffer, 0, 4);
    return WOFF2_MAGIC.every((m, i) => b[i] === m);
}

/**
 * SYNCHRONOUS lightweight inspection for the settings status line (audit M2 +
 * R3-M1): enumerate `fonts/*.woff2`, apply the per-file byte cap via
 * `TFile.stat.size`, count CANDIDATES — NO `readBinary`, NO base64, NO `await`.
 * Synchronous because the manifest was dropped (M3): no async I/O remains, so the
 * settings renderer has no dangling promise.
 */
export function inspectBrandFontCandidates(app: App, settings: AIOrganiserSettings): BrandFontStatus {
    const { dir } = getFontsFolder(app, settings);
    if (!dir) return { folderState: 'absent', count: 0, skipped: [] };
    const files = listFontFiles(dir);
    if (files.length === 0) return { folderState: 'empty', count: 0, skipped: [] };
    const skipped: string[] = [];
    let count = 0;
    for (const f of files) {
        if (f.stat.size > MAX_FONT_BYTES) skipped.push(f.name);
        else count++;
    }
    return { folderState: 'present', count, skipped };
}

/**
 * SYNCHRONOUS fingerprint of the fonts folder (`path:mtime:size` per file) — used
 * by the theme resolver's memo signature so a font add/edit/remove busts the
 * cached theme. `''` when the folder is absent/empty.
 */
export function brandFontsSignature(app: App, settings: AIOrganiserSettings): string {
    const { dir } = getFontsFolder(app, settings);
    if (!dir) return '';
    return listFontFiles(dir).map(f => `${f.path}:${f.stat.mtime}:${f.stat.size}`).join(',');
}

/**
 * Resolve `999_Brand/fonts/*.woff2` → a block of `@font-face` rules binding the
 * brand's primary `family`. Each file: per-file size-cap + running total-budget +
 * `wOF2` magic-validate + base64 `data:font/woff2` src. Weight/style from the
 * filename (`<slug>-<weight>[-italic].woff2`). Family is serialized (quoted-once,
 * R3-H1) — NOT pre-quoted. Fail-closed PER FILE (drop + `skipped[]` + warn).
 * Absent/empty folder → empty result. Byte-bounded LRU cache.
 *
 * Pure binary→base64 (no DOM, no raster) — directly unit-testable.
 */
export async function getBrandFonts(
    app: App,
    settings: AIOrganiserSettings,
    family: string,
): Promise<BrandFontsResult> {
    const { path, dir } = getFontsFolder(app, settings);
    if (!dir) return EMPTY_FONTS;
    const files = listFontFiles(dir);
    if (files.length === 0) return EMPTY_FONTS;

    const cssFamily = serializeCssFontFamily(family);
    // serializeCssFontFamily returns '' for a fully-invalid family — without a
    // family the @font-face can't bind, so degrade to no embed.
    if (!cssFamily) return EMPTY_FONTS;

    const signature = `${path}|${cssFamily}|`
        + files.map(f => `${f.path}:${f.stat.mtime}:${f.stat.size}`).join(',');
    const cached = fontCacheGet(signature);
    if (cached) return cached;

    const faces: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const file of files) {
        if (file.stat.size > MAX_FONT_BYTES) {
            skipped.push(file.name);
            logger.warn('BrandAssets', `font "${file.name}" exceeds ${MAX_FONT_BYTES} bytes — dropped`);
            continue;
        }
        if (total + file.stat.size > MAX_TOTAL_FONT_BYTES) {
            skipped.push(file.name);
            logger.warn('BrandAssets', `font budget ${MAX_TOTAL_FONT_BYTES} bytes exceeded — "${file.name}" + later fonts dropped`);
            break;
        }
        let buf: ArrayBuffer;
        try {
            buf = await app.vault.readBinary(file);
        } catch (e) {
            skipped.push(file.name);
            logger.warn('BrandAssets', `font read failed for "${file.name}"`, e);
            continue;
        }
        if (!hasWoff2Magic(buf)) {
            skipped.push(file.name);
            logger.warn('BrandAssets', `font "${file.name}" is not a valid woff2 (bad magic) — dropped`);
            continue;
        }
        const { weight, style } = parseFaceFromName(file.name);
        const b64 = arrayBufferToBase64(buf);
        total += file.stat.size;
        faces.push(
            `@font-face{font-family:${cssFamily};font-weight:${weight};font-style:${coerceFontStyle(style)};`
            + `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
        );
    }

    const result: BrandFontsResult = { faceCss: faces.join('\n'), count: faces.length, skipped };
    fontCacheSet(signature, result);
    return result;
}
