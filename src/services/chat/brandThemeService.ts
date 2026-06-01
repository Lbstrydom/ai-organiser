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

import { type App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { logger } from '../../utils/logger';
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
    if (!(abstract instanceof TFile)) {
        logger.warn('BrandTheme', `Path is not a file: ${path}`);
        return null;
    }

    try {
        const content = await app.vault.cachedRead(abstract);
        return parseBrandFile(content);
    } catch (e) {
        logger.warn('BrandTheme', `Failed to load brand file: ${e instanceof Error ? e.message : String(e)}`);
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
    const custom = (settings as AIOrganiserSettings & { presentationBrandGuidelinesPath?: string }).presentationBrandGuidelinesPath;
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
