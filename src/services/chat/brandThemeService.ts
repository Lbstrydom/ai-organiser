/**
 * Brand Theme Service
 *
 * Generates CSS themes from brand guidelines files. When brand is enabled,
 * colors and fonts are enforced via CSS variables — LLM uses semantic classes,
 * never raw hex codes. When brand is disabled, a built-in default theme is used.
 *
 * Brand file format: markdown with ## Colors table, ## Typography list,
 * ## Composition Rules list.
 */

import { type App, TFile, normalizePath } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { logger } from '../../utils/logger';
import { type Result, ok, err } from '../../core/result';
import { safeHex, safeFont } from '../presentationIr/themeSafe';
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './presentationConstants';
// Icon data relocated to the neutral registry (dependency inverted — see
// presentation-renderer-fidelity.md D1). Only the path map is needed here (the
// legacy CSS sprite); the registry is the canonical import site for consumers.
import { PRESENTATION_ICONS } from '../presentationIr/iconRegistry';

// ── Icon Catalogue ─────────────────────────────────────────────────────────

/** CSS for rendering inline SVG icons via background-image. */
const ICON_CSS = buildIconCss();

function buildIconCss(): string {
    const rules = Object.entries(PRESENTATION_ICONS).map(([name, path]) => {
        // Encode SVG as data URI — stroke-based, no fill, matches slide text colour
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='${path}'/></svg>`;
        const encoded = svg.replace(/#/g, '%23').replace(/'/g, '%27');
        return `.icon-${name} { --icon-svg: url("data:image/svg+xml,${encoded}"); }`;
    });

    return `/* ── Lucide Icon Sprite (${Object.keys(PRESENTATION_ICONS).length} icons) ── */
.icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1em; height: 1em; vertical-align: -0.125em;
    background: currentColor;
    -webkit-mask-image: var(--icon-svg);
    -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center;
    mask-image: var(--icon-svg);
    mask-size: contain; mask-repeat: no-repeat; mask-position: center;
}
.icon-lg { width: 1.5em; height: 1.5em; }
.icon-xl { width: 2em; height: 2em; }
.icon-2xl { width: 3em; height: 3em; }
.icon-accent { color: var(--brand-accent); }
.icon-primary { color: var(--brand-primary); }
${rules.join('\n')}`;
}


// ── Types ───────────────────────────────────────────────────────────────────

export interface BrandMinFont {
    body: number;
    caption: number;
    table: number;
    footer: number;
}

export interface BrandLayout {
    headerBandIn: number;
    contentTopIn: number;
    footerBandIn: number;
    logoReserveIn: number;
    sideMarginIn: number;
}

export interface BrandTheme {
    css: string;
    promptRules: string;
    auditChecklist: BrandRule[];
    /** Parsed colour roles (also encoded in `css`); exposed so the export-theme
     *  mapper can read them without re-parsing the CSS. Hex with leading `#`. */
    colors: ParsedColors;
    /** Resolved font family (the first declared family + system fallbacks). */
    font: string;
    /** Secondary/fallback font family (bare name, no quotes). */
    fontFallback: string;
    /** Nominal body font size (points). A `## Typography` `Body pt:` key overrides
     *  the neutral default; distinct from the `minFont.body` floor (which clamps a
     *  smaller nominal up, but is NOT itself the nominal size). */
    bodyFontPt: number;
    /** Minimum font floor per role (points). */
    minFont: BrandMinFont;
    /** Safe-area / zone geometry (inches on the 13.33×7.5in canvas). */
    layout: BrandLayout;
    /** Non-fatal parse diagnostics (degrade-to-default, clamp, etc.). */
    warnings: string[];
}

export interface BrandRule {
    id: string;
    description: string;
}

export interface ParsedColors {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    link: string;
}

// ── Generic defaults (BD-2: neutral, no corporate numbers) ───────────────────

/** Neutral nominal body font size (points) when no `Body pt:` key is present.
 *  Distinct from the min-body floor — this is the size text is actually set at. */
export const BRAND_BODY_FONT_DEFAULT = 14;

/** Min-font floor defaults (points). Public, generic. */
export const BRAND_MIN_FONT_DEFAULTS: BrandMinFont = {
    body: 12,
    caption: 10,
    table: 11,
    footer: 9,
};

/** Generic safe-area defaults (inches). A vault `## Layout` overrides these to
 *  match a corporate template master; absent → these neutral values. */
export const BRAND_LAYOUT_DEFAULTS: BrandLayout = {
    headerBandIn: 1.0,
    contentTopIn: 1.6,
    footerBandIn: 7.0,
    logoReserveIn: 2.0,
    sideMarginIn: 0.3,
};

/** Min-font clamp range (points). Out-of-range → clamp + warning. */
const MIN_FONT_RANGE = { min: 8, max: 24 } as const;
/** Layout zone clamp range (inches). Out-of-range → clamp + warning. */
const LAYOUT_RANGE = { min: 0, max: 8 } as const;

const DEFAULT_FONT_FALLBACK = 'Inter';

// ── Default Theme (navy-gold) ───────────────────────────────────────────────

const DEFAULT_COLORS: ParsedColors = {
    primary: '#1A3A5C',
    secondary: '#0F3460',
    accent: '#F5C842',
    background: '#FFFFFF',
    text: '#2D3748',
    link: '#1A3A5C',
};

const DEFAULT_FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";

function buildCssFromColors(colors: ParsedColors, font: string): string {
    // Validate every brand value before it enters the CSS — a brand-guidelines
    // file is user/config-authored, so a malformed colour/font could otherwise
    // break out of the custom-property and inject CSS. safeHex degrades to the
    // role default; safeFont strips anything that could close the declaration.
    const c = (val: string, fallback: string): string => `#${safeHex(val, fallback).hex}`;
    return `:root {
    --brand-primary: ${c(colors.primary, '1A3A5C')};
    --brand-secondary: ${c(colors.secondary, '0F3460')};
    --brand-accent: ${c(colors.accent, 'F5C842')};
    --brand-bg: ${c(colors.background, 'FFFFFF')};
    --brand-text: ${c(colors.text, '2D3748')};
    --brand-link: ${c(colors.link, '1A3A5C')};
    --brand-font: ${safeFont(font)};
}

* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--brand-font); color: var(--brand-text); background: var(--brand-bg); }

.deck { width: 100%; }
.slide {
    width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px;
    padding: 80px 100px;
    display: flex; flex-direction: column;
    position: relative;
    font-size: 28px; line-height: 1.5;
    overflow: hidden;
    background: var(--brand-bg); color: var(--brand-text);
    page-break-after: always;
}

.slide-title {
    background: linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-secondary) 100%);
    color: white;
    justify-content: center; align-items: center; text-align: center;
}
.slide-content { background: var(--brand-bg); color: var(--brand-text); }
.slide-section {
    background: var(--brand-secondary); color: white;
    justify-content: center; align-items: center; text-align: center;
}
.slide-closing {
    background: linear-gradient(135deg, var(--brand-secondary) 0%, var(--brand-primary) 100%);
    color: white;
    justify-content: center; align-items: center; text-align: center;
}

h1 { font-size: 64px; font-weight: 700; margin-bottom: 16px; line-height: 1.2; }
h2 { font-size: 48px; font-weight: 700; color: var(--brand-primary); margin-bottom: 24px; line-height: 1.2; }
h3 { font-size: 32px; font-weight: 600; margin-bottom: 12px; }
.subtitle { font-size: 32px; opacity: 0.85; font-weight: 300; }
.slide-title h1, .slide-section h1, .slide-closing h1 { color: white; }
.slide-title h2, .slide-section h2, .slide-closing h2 { color: white; }

ul, ol { padding-left: 40px; margin: 16px 0; }
li { margin-bottom: 10px; }
strong { font-weight: 700; color: var(--brand-primary); }
a { color: var(--brand-link); text-decoration: underline; }

table { width: 100%; border-collapse: collapse; font-size: 24px; margin: 16px 0; }
th { background: var(--brand-primary); color: white; padding: 16px 20px; text-align: left; font-weight: 600; }
td { padding: 12px 20px; border-bottom: 1px solid #e2e8f0; }
tr:nth-child(even) td { background: #f7fafc; }

.col-container { display: flex; gap: 60px; flex: 1; margin-top: 16px; }
.col { flex: 1; }

.stats-grid { display: flex; gap: 32px; margin-top: 24px; }
.stat-card {
    flex: 1; background: rgba(255,255,255,0.1); border-radius: 16px;
    padding: 32px; text-align: center;
    border: 1px solid rgba(255,255,255,0.15);
}
.stat-card .number { font-size: 72px; font-weight: 700; color: var(--brand-accent); }
.stat-card .label { font-size: 20px; opacity: 0.7; margin-top: 8px; }

.badge { display: inline-block; padding: 4px 14px; border-radius: 14px; font-size: 18px; font-weight: 600; }
.badge-green { background: #c6f6d5; color: #276749; }
.badge-yellow { background: #fefcbf; color: #975a16; }
.badge-red { background: #fed7d7; color: #9b2c2c; }
.badge-blue { background: #bee3f8; color: #2a4365; }

.slide-content h2 {
    border-bottom: 4px solid var(--brand-accent);
    padding-bottom: 12px;
    display: inline-block;
}

.speaker-notes { display: none; }
.slide-num { position: absolute; bottom: 24px; right: 40px; font-size: 18px; opacity: 0.4; }

${ICON_CSS}`;
}

// ── Service ─────────────────────────────────────────────────────────────────

export function getDefaultTheme(): BrandTheme {
    return {
        css: buildCssFromColors(DEFAULT_COLORS, DEFAULT_FONT),
        promptRules: '',
        auditChecklist: [],
        colors: { ...DEFAULT_COLORS },
        font: DEFAULT_FONT,
        fontFallback: DEFAULT_FONT_FALLBACK,
        bodyFontPt: BRAND_BODY_FONT_DEFAULT,
        minFont: { ...BRAND_MIN_FONT_DEFAULTS },
        layout: { ...BRAND_LAYOUT_DEFAULTS },
        warnings: [],
    };
}

/** True only when the brand path resolves to a readable FILE — the SAME
 *  question `loadBrandTheme` answers (previously this returned true for a folder
 *  at the path, then `loadBrandTheme` rejected it → the two disagreed). */
export function isBrandAvailable(app: App, settings: AIOrganiserSettings): boolean {
    const file = app.vault.getAbstractFileByPath(getBrandPath(settings));
    return file instanceof TFile;
}

/**
 * Load + parse the brand-guidelines file. Returns a `Result` that distinguishes
 * the failure modes (missing / not-a-file / read-error) instead of collapsing
 * them all to `null` — the service-boundary convention. Parsing itself never
 * fails (it degrades to defaults per section), so a found-and-read file is `ok`.
 */
export async function loadBrandTheme(app: App, settings: AIOrganiserSettings): Promise<Result<BrandTheme>> {
    const path = getBrandPath(settings);
    const abstract = app.vault.getAbstractFileByPath(path);
    if (!abstract) return err(`brand file not found: ${path}`);
    if (!(abstract instanceof TFile)) return err(`brand path is not a file: ${path}`);
    try {
        const content = await app.vault.cachedRead(abstract);
        return ok(parseBrandFile(content));
    } catch (e) {
        return err(`brand file read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export async function resolveTheme(
    app: App,
    settings: AIOrganiserSettings,
    brandEnabled: boolean
): Promise<BrandTheme> {
    if (!brandEnabled) return getDefaultTheme();
    const brand = await loadBrandTheme(app, settings);
    if (!brand.ok) {
        logger.warn('BrandTheme', brand.error);
        return getDefaultTheme();
    }
    return brand.value;
}

// ── Path Resolution ──────────────────────────────────────────────────────────

/** Resolve the brand-guidelines path, normalised (consistent slashes, no
 *  stray whitespace). A custom path overrides the default `<pluginFolder>/
 *  <configFolder>/brand-guidelines.md`. */
function getBrandPath(settings: AIOrganiserSettings): string {
    const custom = (settings as AIOrganiserSettings & { presentationBrandGuidelinesPath?: string }).presentationBrandGuidelinesPath;
    if (custom && typeof custom === 'string' && custom.trim()) return normalizePath(custom.trim());
    const pluginFolder = (settings.pluginFolder || '').trim();
    const configFolder = (settings.configFolderPath || 'Config').trim();
    return normalizePath(`${pluginFolder}/${configFolder}/brand-guidelines.md`);
}

// ── Section-Scoped Parsing (M7 fix) ─────────────────────────────────────────

function extractSection(content: string, heading: string): string {
    // Find the `## <heading>` line, then capture everything up to the NEXT
    // `## ` heading (or end-of-file). The previous single-regex form used `$`
    // under the `m` flag, whose per-line semantics made the lazy capture stop at
    // the first content line — so only the heading's first line was ever read.
    // Splitting on the next heading boundary captures the full multi-line body.
    const headingRe = new RegExp(`^## ${heading}\\s*$`, 'mi');
    const start = headingRe.exec(content);
    if (!start) return '';
    const bodyStart = start.index + start[0].length;
    const rest = content.slice(bodyStart);
    const nextHeading = /\n## /.exec(rest);
    const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
    // Strip the leading newline left after the heading line.
    return body.replace(/^\r?\n/, '');
}

function parseBrandFile(content: string): BrandTheme {
    const colorsSection = extractSection(content, 'Colors');
    const typographySection = extractSection(content, 'Typography');
    const rulesSection = extractSection(content, 'Composition Rules');
    const layoutSection = extractSection(content, 'Layout');

    const warnings: string[] = [];
    const colors = parseColors(colorsSection);
    const font = parseFont(typographySection);
    const fontFallback = parseFontFallback(typographySection);
    const bodyFontPt = parseNumericKey(typographySection, 'Body pt', BRAND_BODY_FONT_DEFAULT, MIN_FONT_RANGE, warnings);
    const minFont = parseMinFont(typographySection, warnings);
    const layout = parseLayout(layoutSection, warnings);
    const promptRules = parseRules(rulesSection);
    const auditChecklist = parseAuditChecklist(rulesSection);

    return {
        css: buildCssFromColors(colors, font),
        promptRules,
        auditChecklist,
        colors,
        font,
        fontFallback,
        bodyFontPt,
        minFont,
        layout,
        warnings,
    };
}

// ── Typography extras + Layout parsing (degrade-to-default per key) ──────────

/** Read a `- Key: value` bullet line (case-insensitive key) from a section. */
function readBulletValue(section: string, key: string): string | null {
    if (!section) return null;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*[-*]\\s*${escaped}\\s*:\\s*(.+)$`, 'im');
    const m = re.exec(section);
    return m ? m[1].trim() : null;
}

/**
 * Parse a numeric bullet value with degrade-to-default + clamp semantics
 * (plan §4 R2-L2): non-numeric/missing → role default + warning; numeric but
 * out-of-range → CLAMP to the nearest bound + warning; in-range → as-is.
 */
function parseNumericKey(
    section: string,
    key: string,
    fallback: number,
    range: { min: number; max: number },
    warnings: string[],
): number {
    const raw = readBulletValue(section, key);
    if (raw === null) return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) {
        warnings.push(`${key}: "${raw}" is not a number — using default ${fallback}`);
        return fallback;
    }
    if (n < range.min) {
        warnings.push(`${key}: ${n} below ${range.min} — clamped to ${range.min}`);
        return range.min;
    }
    if (n > range.max) {
        warnings.push(`${key}: ${n} above ${range.max} — clamped to ${range.max}`);
        return range.max;
    }
    return n;
}

function parseFontFallback(section: string): string {
    const raw = readBulletValue(section, 'Font fallback');
    return raw && raw.length > 0 ? raw : DEFAULT_FONT_FALLBACK;
}

function parseMinFont(section: string, warnings: string[]): BrandMinFont {
    return {
        body: parseNumericKey(section, 'Min body pt', BRAND_MIN_FONT_DEFAULTS.body, MIN_FONT_RANGE, warnings),
        caption: parseNumericKey(section, 'Min caption pt', BRAND_MIN_FONT_DEFAULTS.caption, MIN_FONT_RANGE, warnings),
        table: parseNumericKey(section, 'Min table pt', BRAND_MIN_FONT_DEFAULTS.table, MIN_FONT_RANGE, warnings),
        footer: parseNumericKey(section, 'Min footer pt', BRAND_MIN_FONT_DEFAULTS.footer, MIN_FONT_RANGE, warnings),
    };
}

function parseLayout(section: string, warnings: string[]): BrandLayout {
    return {
        headerBandIn: parseNumericKey(section, 'Header band in', BRAND_LAYOUT_DEFAULTS.headerBandIn, LAYOUT_RANGE, warnings),
        contentTopIn: parseNumericKey(section, 'Content top in', BRAND_LAYOUT_DEFAULTS.contentTopIn, LAYOUT_RANGE, warnings),
        footerBandIn: parseNumericKey(section, 'Footer band in', BRAND_LAYOUT_DEFAULTS.footerBandIn, LAYOUT_RANGE, warnings),
        logoReserveIn: parseNumericKey(section, 'Logo reserve in', BRAND_LAYOUT_DEFAULTS.logoReserveIn, LAYOUT_RANGE, warnings),
        sideMarginIn: parseNumericKey(section, 'Side margin in', BRAND_LAYOUT_DEFAULTS.sideMarginIn, LAYOUT_RANGE, warnings),
    };
}

// H1 fix: deterministic color parsing with explicit role mapping
function parseColors(section: string): ParsedColors {
    const colors: ParsedColors = { ...DEFAULT_COLORS };
    if (!section) return colors;

    const roleMap: Record<string, keyof ParsedColors> = {};
    const rows = section.match(/\|[^|]+\|[^|]+\|[^|]+\|/g) || [];

    for (const row of rows) {
        const cells = row.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length < 3) continue;

        const role = cells[0].toLowerCase();
        const hex = (cells[2].match(/#[0-9A-Fa-f]{6}/) || [])[0];
        if (!hex) continue;

        // Skip header rows
        if (role === 'role' || role === '---' || role.startsWith('-')) continue;

        // Map role keywords to color slots — first match wins per slot
        if (role.includes('accent') && !roleMap['accent']) {
            colors.accent = hex;
            roleMap['accent'] = 'accent';
        } else if (role.includes('background') && !roleMap['background']) {
            colors.background = hex;
            roleMap['background'] = 'background';
        } else if (role.includes('text') && !role.includes('link') && !roleMap['text']) {
            colors.text = hex;
            roleMap['text'] = 'text';
        } else if (role.includes('link') && !roleMap['link']) {
            colors.link = hex;
            roleMap['link'] = 'link';
        } else if (role.includes('primary') || role.includes('secondary')) {
            if (!roleMap['primary']) {
                colors.primary = hex;
                roleMap['primary'] = 'primary';
            } else if (!roleMap['secondary']) {
                colors.secondary = hex;
                roleMap['secondary'] = 'secondary';
            }
        }
    }

    return colors;
}

function parseFont(section: string): string {
    if (!section) return DEFAULT_FONT;
    const fontMatch = /[-*]\s*Font:\s*(.+)/i.exec(section);
    if (fontMatch) return `'${fontMatch[1].trim()}', system-ui, sans-serif`;
    return DEFAULT_FONT;
}

function parseRules(section: string): string {
    if (!section) return '';
    return section
        .split('\n')
        .filter(l => l.trim().startsWith('-'))
        .map(l => l.trim().replace(/^-\s*/, ''))
        .filter(Boolean)
        .join('\n');
}

function parseAuditChecklist(section: string): BrandRule[] {
    if (!section) return [];
    return section
        .split('\n')
        .filter(l => l.trim().startsWith('-'))
        .map((l, i) => ({ id: `rule-${i}`, description: l.trim().replace(/^-\s*/, '') }))
        .filter(r => r.description.length > 0);
}
