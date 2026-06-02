import { describe, it, expect } from 'vitest';
import { safeHex, safeFont, sanitizeExportTheme } from '../src/services/presentationIr/themeSafe';
import { resolveTheme } from '../src/services/export/exportTheme';

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
    it('sanitises a malicious fontFace', () => {
        const t = sanitizeExportTheme({ ...base, fontFace: 'Evil"; color:red; }' }, () => {});
        expect(t.fontFace).not.toContain(';');
        expect(t.fontFace).not.toContain('}');
    });
});
