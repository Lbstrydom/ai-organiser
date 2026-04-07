import { describe, it, expect } from 'vitest';
import {
    PRESENTATION_ICONS,
    ICON_CATEGORIES,
    buildIconReference,
    getDefaultTheme,
} from '../src/services/chat/brandThemeService';

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
