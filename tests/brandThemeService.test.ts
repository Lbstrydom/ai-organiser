import { describe, it, expect } from 'vitest';
import { getDefaultTheme, loadBrandTheme, isBrandAvailable, resolveTheme } from '../src/services/chat/brandThemeService';
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
