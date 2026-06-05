import { describe, it, expect } from 'vitest';
import {
    safeHex, safeFont, sanitizeExportTheme,
    sanitizeCssFontFamily, serializeCssFontFamily, sanitizeCssFontFamilyList,
    firstCssFontFamily, coerceFontWeight, coerceFontStyle,
} from '../src/services/presentationIr/themeSafe';
import { resolveTheme } from '../src/services/export/exportTheme';
import type { ExportTheme } from '../src/services/export/exportTheme';

describe('safeHex', () => {
    it('accepts a 6-hex with or without # → canonical no-# uppercase, ok', () => {
        expect(safeHex('1a3a5c', 'FFFFFF')).toEqual({ hex: '1A3A5C', ok: true });
        expect(safeHex('#f5c842', 'FFFFFF')).toEqual({ hex: 'F5C842', ok: true });
    });
    it('degrades a malformed colour to the fallback with ok:false', () => {
        for (const bad of ['123', '1234567', 'GGGGGG', 'red', '', '12#456', '#xyz']) {
            const r = safeHex(bad, '1A3A5C');
            expect(r.ok, bad).toBe(false);
            expect(r.hex, bad).toBe('1A3A5C');
        }
    });
    it('uses a neutral 000000 when the fallback is itself malformed', () => {
        expect(safeHex('nope', 'also-bad')).toEqual({ hex: '000000', ok: false });
    });
    it('never throws on null/undefined input', () => {
        expect(() => safeHex(undefined as unknown as string, 'FFFFFF')).not.toThrow();
        expect(safeHex(undefined as unknown as string, 'FFFFFF').ok).toBe(false);
    });
});

describe('safeFont', () => {
    it('keeps valid font names and stacks (spaces, hyphens, commas)', () => {
        expect(safeFont('Noto Sans')).toBe('Noto Sans');
        expect(safeFont('Noto Sans, system-ui, sans-serif')).toBe('Noto Sans, system-ui, sans-serif');
        expect(safeFont('Segoe-UI')).toBe('Segoe-UI');
    });
    it('strips characters that could break out of the CSS/PPTX context', () => {
        expect(safeFont('Evil"; color:red; }')).not.toContain(';');
        expect(safeFont('Evil"; color:red; }')).not.toContain('}');
        expect(safeFont("a'b<c>")).toBe('abc');
    });
    it('falls back to a system stack when nothing usable remains', () => {
        expect(safeFont('<>{};')).toBe('sans-serif');
        expect(safeFont('')).toBe('sans-serif');
    });
});

describe('sanitizeExportTheme', () => {
    const base = resolveTheme('navy-gold', '', '', 'Inter', 14);
    it('passes a valid theme through with no onInvalid calls', () => {
        const bad: string[] = [];
        const t = sanitizeExportTheme(base, f => bad.push(f));
        expect(bad).toEqual([]);
        expect(t.primaryColor.toUpperCase()).toBe(base.primaryColor.replace('#', '').toUpperCase());
    });
    it('degrades a malformed colour to the default and fires onInvalid(field)', () => {
        const bad: string[] = [];
        const t = sanitizeExportTheme({ ...base, primaryColor: 'not-hex' }, f => bad.push(f));
        expect(bad).toContain('primaryColor');
        expect(t.primaryColor).toBe('1A3A5C');
    });
    it('sanitises a malicious fontFace AND fires onInvalid (M8)', () => {
        const bad: string[] = [];
        const t = sanitizeExportTheme({ ...base, fontFace: 'Evil"; color:red; }' }, f => bad.push(f));
        expect(t.fontFace).not.toContain(';');
        expect(t.fontFace).not.toContain('}');
        expect(bad).toContain('fontFace');
    });
    it('does NOT fire onInvalid for a benign font (incl. extra whitespace)', () => {
        const bad: string[] = [];
        sanitizeExportTheme({ ...base, fontFace: 'Noto  Sans' }, f => bad.push(f));
        expect(bad).not.toContain('fontFace');
    });
});

// ── CSS font-family sanitize / serialize (brand-font-embedding H3 + R3-H1) ──

describe('sanitizeCssFontFamily (validate → bare raw)', () => {
    it('keeps a clean family bare and unquoted', () => {
        expect(sanitizeCssFontFamily('Noto Sans')).toBe('Noto Sans');
        expect(sanitizeCssFontFamily('  Noto   Sans  ')).toBe('Noto Sans');
    });
    it('strips every CSS-injection char (quotes/semicolons/braces/comma/angle)', () => {
        expect(sanitizeCssFontFamily("foo'; } body{}")).toBe('foo  body'.replace(/\s+/g, ' '));
        expect(sanitizeCssFontFamily('a</style>b')).toBe('astyleb');
        expect(sanitizeCssFontFamily('Noto, Sans')).toBe('Noto Sans'); // comma stripped (single family)
    });
    it('returns empty for fully-invalid input', () => {
        expect(sanitizeCssFontFamily('@#$%')).toBe('');
        expect(sanitizeCssFontFamily('')).toBe('');
    });
    it('preserves international (non-ASCII) family names (Gemini-M6)', () => {
        expect(sanitizeCssFontFamily('思源黑体')).toBe('思源黑体');       // CJK
        expect(sanitizeCssFontFamily('Noto Sans 日本語')).toBe('Noto Sans 日本語');
        expect(sanitizeCssFontFamily('Größe Sans')).toBe('Größe Sans'); // accented
        // …while still stripping injection chars from an international string:
        expect(sanitizeCssFontFamily('思源; }body{')).toBe('思源 body');
    });
});

describe('sanitizeExportTheme — observability (Gemini-M8, uses the real allowlist)', () => {
    const base: ExportTheme = {
        primaryColor: '1A3A5C', accentColor: 'F5C842', sectionBg: '1D6B4A',
        bodyColor: '2D4A5A', fontFace: 'Noto Sans', fontSize: 14,
    };
    it('fires onInvalid when an injection-class char is present', () => {
        const bad: string[] = [];
        sanitizeExportTheme({ ...base, fontFace: 'Noto}; evil' }, f => bad.push(f));
        expect(bad).toContain('fontFace');
    });
    it('does NOT fire for a benign stack with commas/quotes (no misfire)', () => {
        const bad: string[] = [];
        sanitizeExportTheme({ ...base, fontFace: "'Noto Sans', system-ui, sans-serif" }, f => bad.push(f));
        expect(bad).not.toContain('fontFace');
    });
    it('does NOT fire for an international family name', () => {
        const bad: string[] = [];
        sanitizeExportTheme({ ...base, fontFace: '思源黑体, sans-serif' }, f => bad.push(f));
        expect(bad).not.toContain('fontFace');
    });
});

describe('serializeCssFontFamily (render → CSS token, quoted-once)', () => {
    it('quotes a non-generic family exactly once', () => {
        expect(serializeCssFontFamily('Noto Sans')).toBe("'Noto Sans'");
        expect(serializeCssFontFamily("'Noto Sans'")).toBe("'Noto Sans'"); // not ''Noto Sans''
    });
    it('leaves generics bare', () => {
        expect(serializeCssFontFamily('sans-serif')).toBe('sans-serif');
        expect(serializeCssFontFamily('system-ui')).toBe('system-ui');
        expect(serializeCssFontFamily('monospace')).toBe('monospace');
    });
});

describe('sanitizeCssFontFamilyList', () => {
    it('serializes a stack, quotes families, keeps generics bare, ensures a generic', () => {
        expect(sanitizeCssFontFamilyList('Noto Sans, system-ui, sans-serif'))
            .toBe("'Noto Sans', system-ui, sans-serif");
    });
    it('appends a trailing generic when none present', () => {
        expect(sanitizeCssFontFamilyList('Noto Sans')).toBe("'Noto Sans', sans-serif");
    });
    it('dedupes case-insensitively', () => {
        expect(sanitizeCssFontFamilyList('Inter, inter, sans-serif')).toBe("'Inter', sans-serif");
    });
    it('neutralises an injection payload in a fallback (H3)', () => {
        const out = sanitizeCssFontFamilyList("foo'; } body{display:none} '");
        expect(out).not.toMatch(/[;{}]/);
        expect(out).not.toContain('</style>');
    });
    it('empty/garbage → sans-serif', () => {
        expect(sanitizeCssFontFamilyList('')).toBe('sans-serif');
        expect(sanitizeCssFontFamilyList('@#$,%^&')).toBe('sans-serif');
    });
});

describe('firstCssFontFamily', () => {
    it('returns the bare first family of a stack', () => {
        expect(firstCssFontFamily('Noto Sans, system-ui')).toBe('Noto Sans');
        expect(firstCssFontFamily('Inter')).toBe('Inter');
    });
    it('empty → sans-serif', () => {
        expect(firstCssFontFamily('')).toBe('sans-serif');
    });
});

describe('coerceFontWeight / coerceFontStyle', () => {
    it('clamps weight to an int in [1,1000], else 400', () => {
        expect(coerceFontWeight('700')).toBe(700);
        expect(coerceFontWeight(400)).toBe(400);
        expect(coerceFontWeight(0)).toBe(400);
        expect(coerceFontWeight(2000)).toBe(400);
        expect(coerceFontWeight('abc')).toBe(400);
    });
    it('coerces style to the enum', () => {
        expect(coerceFontStyle('italic')).toBe('italic');
        expect(coerceFontStyle('oblique')).toBe('oblique');
        expect(coerceFontStyle('bold')).toBe('normal');
        expect(coerceFontStyle(undefined)).toBe('normal');
    });
});

describe('sanitizeExportTheme — font invariant (Gemini-R1-H1)', () => {
    const base: ExportTheme = {
        primaryColor: '1A3A5C', accentColor: 'F5C842', sectionBg: '1D6B4A',
        bodyColor: '2D4A5A', fontFace: 'Noto Sans', fontSize: 14,
    };
    it('ALWAYS populates fontStack from a single-family fontFace', () => {
        const t = sanitizeExportTheme({ ...base, fontFace: 'Noto Sans' });
        expect(t.fontStack).toBe("'Noto Sans', sans-serif");
        expect(t.fontFace).toBe('Noto Sans'); // bare for PPTX
    });
    it('does NOT comma-strip an off-brand fontFace that is itself a stack', () => {
        const t = sanitizeExportTheme({ ...base, fontFace: 'Inter, sans-serif' });
        expect(t.fontStack).toBe("'Inter', sans-serif"); // NOT 'Inter sans-serif'
        expect(t.fontFace).toBe('Inter'); // first bare family for PPTX
    });
    it('prefers an explicit brand fontStack when present', () => {
        const t = sanitizeExportTheme({ ...base, fontFace: 'Noto Sans', fontStack: "'Noto Sans', system-ui, sans-serif" });
        expect(t.fontStack).toBe("'Noto Sans', system-ui, sans-serif");
    });
});
