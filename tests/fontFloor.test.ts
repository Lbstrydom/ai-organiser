import { describe, it, expect } from 'vitest';
import { clampFixedFont, fontFloor } from '../src/services/presentationIr/fontFloor';
import { resolveTheme } from '../src/services/export/exportTheme';
import type { ExportTheme } from '../src/services/export/exportTheme';

// Non-brand theme: minFont explicitly absent → every helper is a pass-through.
// (resolveTheme seeds default floors, so we strip them for the pass-through case.)
const noFloor: ExportTheme = { ...resolveTheme('navy-gold', '', '', 'Inter', 14), minFont: undefined };
// Brand theme: explicit floors on every role.
const withFloor: ExportTheme = { ...noFloor, minFont: { body: 12, caption: 14, table: 12, footer: 11 } };

describe('clampFixedFont', () => {
    it('passes the intended value through when no floor is set', () => {
        expect(clampFixedFont(noFloor, 'caption', 11)).toBe(11);
        expect(clampFixedFont(noFloor, 'footer', 10)).toBe(10);
        expect(clampFixedFont(noFloor, 'table', 9)).toBe(9);
    });
    it('clamps UP to the role floor when the intended value is below it', () => {
        expect(clampFixedFont(withFloor, 'caption', 11)).toBe(14);   // floor 14 > 11
        expect(clampFixedFont(withFloor, 'footer', 10)).toBe(11);    // floor 11 > 10
    });
    it('leaves the intended value when it already meets/exceeds the floor', () => {
        expect(clampFixedFont(withFloor, 'caption', 20)).toBe(20);   // 20 > floor 14
    });
});

describe('fontFloor', () => {
    it('returns -Infinity when no floor is set (shrink unaffected)', () => {
        expect(fontFloor(noFloor, 'body')).toBe(-Infinity);
        expect(fontFloor(noFloor, 'caption')).toBe(-Infinity);
    });
    it('returns the role floor when set', () => {
        expect(fontFloor(withFloor, 'body')).toBe(12);
        expect(fontFloor(withFloor, 'footer')).toBe(11);
    });
});
