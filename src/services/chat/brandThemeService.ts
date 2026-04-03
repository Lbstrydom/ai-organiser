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

import type { App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { logger } from '../../utils/logger';
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './presentationConstants';

// ── Icon Catalogue ─────────────────────────────────────────────────────────
// Curated subset of Lucide icons (ISC licence, same set Obsidian uses).
// Inline SVGs so slides stay self-contained with zero network dependency.
// LLM references icons via <span class="icon icon-{name}"></span>.

/** Map of icon-name → SVG path data (24×24 viewBox, stroke-based). */
export const PRESENTATION_ICONS: Record<string, string> = {
    // ── Navigation / Actions ───────────────────────────────────────────────
    'arrow-right':      'M5 12h14M12 5l7 7-7 7',
    'arrow-up-right':   'M7 17L17 7M7 7h10v10',
    'check':            'M20 6L9 17l-5-5',
    'check-circle':     'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
    'x':                'M18 6L6 18M6 6l12 12',
    'external-link':    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
    'plus':             'M12 5v14M5 12h14',
    'minus':            'M5 12h14',
    // ── Data / Analytics ───────────────────────────────────────────────────
    'bar-chart':        'M12 20V10M18 20V4M6 20v-4',
    'trending-up':      'M23 6l-9.5 9.5-5-5L1 18',
    'trending-down':    'M23 18l-9.5-9.5-5 5L1 6',
    'pie-chart':        'M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z',
    'activity':         'M22 12h-4l-3 9L9 3l-3 9H2',
    'percent':          'M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    // ── Business / Finance ─────────────────────────────────────────────────
    'dollar-sign':      'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    'briefcase':        'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
    'building':         'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2',
    'landmark':         'M3 22h18M6 18v-4M10 18v-4M14 18v-4M18 18v-4M2 10l10-7 10 7',
    // ── People / Team ──────────────────────────────────────────────────────
    'user':             'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'users':            'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    // ── Communication ──────────────────────────────────────────────────────
    'mail':             'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6',
    'message-circle':   'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
    'phone':            'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z',
    // ── Technology ─────────────────────────────────────────────────────────
    'globe':            'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    'cpu':              'M18 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
    'cloud':            'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
    'wifi':             'M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01',
    'lock':             'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
    'shield':           'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    // ── Content / Media ────────────────────────────────────────────────────
    'file-text':        'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    'image':            'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
    'video':            'M23 7l-7 5 7 5zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
    'book-open':        'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
    // ── Science / Nature ───────────────────────────────────────────────────
    'zap':              'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
    'sun':              'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
    'leaf':             'M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
    'droplet':          'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z',
    // ── Objects / Tools ────────────────────────────────────────────────────
    'settings':         'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'tool':             'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    'calendar':         'M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18',
    'clock':            'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    'map-pin':          'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    // ── Status / Indicators ────────────────────────────────────────────────
    'alert-triangle':   'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    'info':             'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    'help-circle':      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
    'star':             'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    'heart':            'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
    'thumbs-up':        'M14 9V5.5a2.5 2.5 0 0 0-5 0V9M9 22h4a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L9 3M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3',
    // ── Arrows / Process ───────────────────────────────────────────────────
    'refresh-cw':       'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    'target':           'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'layers':           'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    'git-branch':       'M6 3v12M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    'rocket':           'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3M22 2l-7.5 7.5M15 2H22v7',
};

/** Icon names grouped by category for prompt reference. */
export const ICON_CATEGORIES: Record<string, string[]> = {
    'data & analytics':     ['bar-chart', 'trending-up', 'trending-down', 'pie-chart', 'activity', 'percent', 'target'],
    'business & finance':   ['dollar-sign', 'briefcase', 'building', 'landmark'],
    'people & team':        ['user', 'users'],
    'communication':        ['mail', 'message-circle', 'phone'],
    'technology':           ['globe', 'cpu', 'cloud', 'wifi', 'lock', 'shield'],
    'content & media':      ['file-text', 'image', 'video', 'book-open'],
    'science & nature':     ['zap', 'sun', 'leaf', 'droplet'],
    'objects & tools':      ['settings', 'tool', 'calendar', 'clock', 'map-pin'],
    'status & indicators':  ['check', 'check-circle', 'x', 'alert-triangle', 'info', 'help-circle', 'star', 'heart', 'thumbs-up'],
    'arrows & process':     ['arrow-right', 'arrow-up-right', 'external-link', 'plus', 'minus', 'refresh-cw', 'layers', 'git-branch', 'rocket'],
};

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

/** Build the icon reference block for the LLM prompt. */
export function buildIconReference(): string {
    const lines = Object.entries(ICON_CATEGORIES).map(([category, names]) =>
        `  ${category}: ${names.join(', ')}`
    );
    return lines.join('\n');
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface BrandTheme {
    css: string;
    promptRules: string;
    auditChecklist: BrandRule[];
}

export interface BrandRule {
    id: string;
    description: string;
}

interface ParsedColors {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    link: string;
}

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
    return `:root {
    --brand-primary: ${colors.primary};
    --brand-secondary: ${colors.secondary};
    --brand-accent: ${colors.accent};
    --brand-bg: ${colors.background};
    --brand-text: ${colors.text};
    --brand-link: ${colors.link};
    --brand-font: ${font};
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
    };
}

export function isBrandAvailable(app: App, settings: AIOrganiserSettings): boolean {
    const path = getBrandPath(settings);
    return !!app.vault.getAbstractFileByPath(path);
}

export async function loadBrandTheme(app: App, settings: AIOrganiserSettings): Promise<BrandTheme | null> {
    const path = getBrandPath(settings);
    const abstract = app.vault.getAbstractFileByPath(path);
    if (!abstract) return null;

    // Verify it's a file, not a folder (M6 fix)
    if (!('extension' in abstract)) {
        logger.warn('BrandTheme', `Path is not a file: ${path}`);
        return null;
    }
    const file = abstract as TFile;

    try {
        const content = await app.vault.cachedRead(file);
        return parseBrandFile(content);
    } catch (e) {
        logger.warn('BrandTheme', `Failed to load brand file: ${e}`);
        return null;
    }
}

export async function resolveTheme(
    app: App,
    settings: AIOrganiserSettings,
    brandEnabled: boolean
): Promise<BrandTheme> {
    if (!brandEnabled) return getDefaultTheme();
    const brand = await loadBrandTheme(app, settings);
    return brand ?? getDefaultTheme();
}

// ── Path Resolution (M5 fix — uses settings helpers) ────────────────────────

function getBrandPath(settings: AIOrganiserSettings): string {
    const custom = (settings as any).presentationBrandGuidelinesPath;
    if (custom && typeof custom === 'string' && custom.trim()) return custom.trim();
    const configFolder = settings.configFolderPath || 'Config';
    return `${settings.pluginFolder}/${configFolder}/brand-guidelines.md`;
}

// ── Section-Scoped Parsing (M7 fix) ─────────────────────────────────────────

function extractSection(content: string, heading: string): string {
    const regex = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'mi');
    const match = regex.exec(content);
    return match ? match[1] : '';
}

function parseBrandFile(content: string): BrandTheme {
    const colorsSection = extractSection(content, 'Colors');
    const typographySection = extractSection(content, 'Typography');
    const rulesSection = extractSection(content, 'Composition Rules');

    const colors = parseColors(colorsSection);
    const font = parseFont(typographySection);
    const promptRules = parseRules(rulesSection);
    const auditChecklist = parseAuditChecklist(rulesSection);

    return {
        css: buildCssFromColors(colors, font),
        promptRules,
        auditChecklist,
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
