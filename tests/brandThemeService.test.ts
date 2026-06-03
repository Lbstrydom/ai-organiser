import { describe, it, expect } from 'vitest';
import {
    getDefaultTheme, loadBrandTheme, isBrandAvailable, resolveTheme,
    BRAND_MIN_FONT_DEFAULTS, BRAND_LAYOUT_DEFAULTS,
} from '../src/services/chat/brandThemeService';
import {
    PRESENTATION_ICONS,
    ICON_CATEGORIES,
    buildIconReference,
} from '../src/services/presentationIr/iconRegistry';
import { createTFile, createTFolder } from './mocks/obsidian';
import type { App } from 'obsidian';
import type { AIOrganiserSettings } from '../src/core/settings';

const SETTINGS = { pluginFolder: 'AI-Organiser', configFolderPath: 'Config' } as unknown as AIOrganiserSettings;
function makeApp(file: unknown, content = '', throwOnRead = false): App {
    return {
        vault: {
            getAbstractFileByPath: () => file,
            cachedRead: async () => { if (throwOnRead) throw new Error('boom'); return content; },
        },
    } as unknown as App;
}

describe('isBrandAvailable — file-only (reconciled with loadBrandTheme)', () => {
    it('true for a TFile at the path', () => {
        expect(isBrandAvailable(makeApp(createTFile('x/brand-guidelines.md')), SETTINGS)).toBe(true);
    });
    it('false for a FOLDER at the path (the bug it fixes)', () => {
        expect(isBrandAvailable(makeApp(createTFolder('x')), SETTINGS)).toBe(false);
    });
    it('false when nothing is there', () => {
        expect(isBrandAvailable(makeApp(null), SETTINGS)).toBe(false);
    });
});

describe('loadBrandTheme — Result with distinct failure modes', () => {
    it('err when the file is missing', async () => {
        const r = await loadBrandTheme(makeApp(null), SETTINGS);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('not found');
    });
    it('err when the path is a folder', async () => {
        const r = await loadBrandTheme(makeApp(createTFolder('x')), SETTINGS);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('not a file');
    });
    it('err when the read throws', async () => {
        const r = await loadBrandTheme(makeApp(createTFile('x/brand-guidelines.md'), '', true), SETTINGS);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('read failed');
    });
    it('ok for a readable file (parse degrades to defaults per section)', async () => {
        const r = await loadBrandTheme(makeApp(createTFile('x/brand-guidelines.md'), '## Colors\n'), SETTINGS);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.css).toContain('--brand-primary');
    });
});

describe('resolveTheme falls back to the default theme on a brand-load failure', () => {
    it('returns the default theme when the brand file is missing', async () => {
        const t = await resolveTheme(makeApp(null), SETTINGS, true);
        expect(t.css).toContain('--brand-primary');
        expect(t.auditChecklist).toEqual([]);
    });
    it('returns the default theme when brand is disabled', async () => {
        const t = await resolveTheme(makeApp(createTFile('x/brand-guidelines.md')), SETTINGS, false);
        expect(t.css).toContain('--brand-primary');
    });
});

// ── Typography extras + Layout parsing ──────────────────────────────────────

async function parse(content: string) {
    const r = await loadBrandTheme(makeApp(createTFile('x/brand-guidelines.md'), content), SETTINGS);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.value;
}

describe('brand parsing — min-font + layout + font-fallback', () => {
    it('degrades to role defaults when sections absent', async () => {
        const v = await parse('## Colors\n');
        expect(v.minFont).toEqual(BRAND_MIN_FONT_DEFAULTS);
        expect(v.layout).toEqual(BRAND_LAYOUT_DEFAULTS);
        expect(v.fontFallback).toBe('Inter');
        expect(v.warnings).toEqual([]);
    });

    it('parses min-font keys (case-insensitive bullets)', async () => {
        const v = await parse('## Typography\n- min body pt: 14\n- Min caption pt: 11\n- Min table pt: 13\n- Min footer pt: 8\n');
        expect(v.minFont).toEqual({ body: 14, caption: 11, table: 13, footer: 8 });
        expect(v.warnings).toEqual([]);
    });

    it('parses font + font fallback', async () => {
        const v = await parse('## Typography\n- Font: Noto Sans\n- Font fallback: Roboto\n');
        expect(v.font).toContain('Noto Sans');
        expect(v.fontFallback).toBe('Roboto');
    });

    it('clamps out-of-range min-font + warns', async () => {
        const v = await parse('## Typography\n- Min body pt: 30\n- Min footer pt: 2\n');
        expect(v.minFont.body).toBe(24);
        expect(v.minFont.footer).toBe(8);
        expect(v.warnings.some(w => w.includes('Min body pt') && w.includes('24'))).toBe(true);
        expect(v.warnings.some(w => w.includes('Min footer pt') && w.includes('8'))).toBe(true);
    });

    it('non-numeric min-font → default + warn', async () => {
        const v = await parse('## Typography\n- Min body pt: huge\n');
        expect(v.minFont.body).toBe(BRAND_MIN_FONT_DEFAULTS.body);
        expect(v.warnings.some(w => w.includes('Min body pt') && w.includes('not a number'))).toBe(true);
    });

    it('parses ## Layout zones', async () => {
        const v = await parse('## Layout\n- Header band in: 1.0\n- Content top in: 1.95\n- Footer band in: 7.23\n- Logo reserve in: 2.25\n- Side margin in: 0.25\n');
        expect(v.layout).toEqual({ headerBandIn: 1.0, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25 });
    });

    it('clamps out-of-range layout + warns', async () => {
        const v = await parse('## Layout\n- Content top in: 12\n- Side margin in: -1\n');
        expect(v.layout.contentTopIn).toBe(8);
        expect(v.layout.sideMarginIn).toBe(0);
        expect(v.warnings.some(w => w.includes('Content top in'))).toBe(true);
        expect(v.warnings.some(w => w.includes('Side margin in'))).toBe(true);
    });

    it('exposes parsed colour roles on the theme', async () => {
        const v = await parse('## Colors\n| Role | Name | Hex |\n| primary | x | #112233 |\n| accent | y | #AABBCC |\n');
        expect(v.colors.primary).toBe('#112233');
        expect(v.colors.accent).toBe('#AABBCC');
    });

    it('getDefaultTheme carries the new fields', () => {
        const t = getDefaultTheme();
        expect(t.minFont).toEqual(BRAND_MIN_FONT_DEFAULTS);
        expect(t.layout).toEqual(BRAND_LAYOUT_DEFAULTS);
        expect(t.warnings).toEqual([]);
        expect(t.colors.primary).toBeTruthy();
    });
});

// ── Icon Catalogue ─────────────────────────────────────────────────────────

describe('PRESENTATION_ICONS', () => {
    it('contains at least 40 icons', () => {
        expect(Object.keys(PRESENTATION_ICONS).length).toBeGreaterThanOrEqual(40);
    });

    it('every entry has non-empty SVG path data', () => {
        for (const [name, path] of Object.entries(PRESENTATION_ICONS)) {
            expect(path, `icon "${name}" has empty path`).toBeTruthy();
            expect(typeof path).toBe('string');
        }
    });

    it('icon names use kebab-case only', () => {
        for (const name of Object.keys(PRESENTATION_ICONS)) {
            expect(name, `icon "${name}" is not kebab-case`).toMatch(/^[a-z][a-z0-9-]*$/);
        }
    });
});

// ── Icon Categories ────────────────────────────────────────────────────────

describe('ICON_CATEGORIES', () => {
    it('has at least 8 categories', () => {
        expect(Object.keys(ICON_CATEGORIES).length).toBeGreaterThanOrEqual(8);
    });

    it('every icon in categories exists in PRESENTATION_ICONS', () => {
        for (const [category, names] of Object.entries(ICON_CATEGORIES)) {
            for (const name of names) {
                expect(PRESENTATION_ICONS, `icon "${name}" in category "${category}" not in PRESENTATION_ICONS`).toHaveProperty(name);
            }
        }
    });

    it('every icon in PRESENTATION_ICONS appears in at least one category', () => {
        const allCategorised = new Set(Object.values(ICON_CATEGORIES).flat());
        for (const name of Object.keys(PRESENTATION_ICONS)) {
            expect(allCategorised.has(name), `icon "${name}" not in any category`).toBe(true);
        }
    });
});

// ── buildIconReference ─────────────────────────────────────────────────────

describe('buildIconReference', () => {
    it('returns a non-empty string', () => {
        const ref = buildIconReference();
        expect(ref.length).toBeGreaterThan(0);
    });

    it('includes category names', () => {
        const ref = buildIconReference();
        expect(ref).toContain('data & analytics');
        expect(ref).toContain('business & finance');
        expect(ref).toContain('people & team');
    });

    it('includes icon names', () => {
        const ref = buildIconReference();
        expect(ref).toContain('bar-chart');
        expect(ref).toContain('briefcase');
        expect(ref).toContain('globe');
    });
});

// ── Default Theme Icon CSS ─────────────────────────────────────────────────

describe('getDefaultTheme icon CSS', () => {
    it('default theme CSS includes icon base class', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('.icon {');
        expect(theme.css).toContain('mask-image');
    });

    it('default theme CSS includes icon name classes', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('.icon-bar-chart');
        expect(theme.css).toContain('.icon-check');
        expect(theme.css).toContain('.icon-rocket');
    });

    it('default theme CSS includes size variants', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('.icon-lg');
        expect(theme.css).toContain('.icon-xl');
        expect(theme.css).toContain('.icon-2xl');
    });

    it('default theme CSS includes colour variants', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('.icon-accent');
        expect(theme.css).toContain('.icon-primary');
    });

    it('icon CSS uses data URIs with encoded SVG', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('data:image/svg+xml');
        // Single quotes encoded as %27 in data URIs
        expect(theme.css).toContain('xmlns=%27http://www.w3.org/2000/svg%27');
    });

    it('icon SVGs use currentColor for theme integration', () => {
        const theme = getDefaultTheme();
        expect(theme.css).toContain('stroke=%27currentColor%27');
    });
});
