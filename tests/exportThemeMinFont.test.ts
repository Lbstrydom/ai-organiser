import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../src/services/export/exportTheme';

describe('resolveTheme — universal min-font floor', () => {
    it('sets minFont on the preset (non-brand) path from passed values', () => {
        const theme = resolveTheme('navy-gold', '', '', 'Inter', 14, 13, 11, 12);
        expect(theme.minFont).toEqual({ body: 13, caption: 11, table: 12, footer: 9 });
    });

    it('sets minFont on the custom path too', () => {
        const theme = resolveTheme('custom', '112233', 'AABBCC', 'Inter', 16, 14, 10, 11);
        expect(theme.minFont).toEqual({ body: 14, caption: 10, table: 11, footer: 9 });
    });

    it('applies defaults when min-font args are omitted (universal floor)', () => {
        const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);
        expect(theme.minFont).toEqual({ body: 12, caption: 10, table: 11, footer: 9 });
    });

    it('keeps footer as a fixed code constant (not user-editable)', () => {
        const theme = resolveTheme('navy-gold', '', '', 'Inter', 14, 20, 20, 20);
        expect(theme.minFont?.footer).toBe(9);
    });

    it('falls back per-role when an individual arg is non-finite', () => {
        const theme = resolveTheme('navy-gold', '', '', 'Inter', 14, NaN, undefined, 12);
        expect(theme.minFont).toEqual({ body: 12, caption: 10, table: 12, footer: 9 });
    });

    it('applies the floor to an unknown scheme (falls back to navy-gold preset)', () => {
        const theme = resolveTheme('does-not-exist', '', '', 'Inter', 14, 13, 11, 12);
        expect(theme.minFont).toEqual({ body: 13, caption: 11, table: 12, footer: 9 });
    });
});
