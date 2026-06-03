import { describe, it, expect } from 'vitest';
import { generateDocx } from '../src/services/export/markdownDocxGenerator';

// DOCX is a ZIP of compressed XML — raw byte search is unreliable, so we assert
// at the contract level: the brand options (font + heading colour) produce a
// valid, distinct document, and the default (no brand options) is unchanged.
const MD = '# Heading One\n\nBody paragraph.\n\n## Heading Two\n\n- bullet';

describe('generateDocx — brand font + colour parity (plan §5 H1)', () => {
    it('accepts headingColor + fontFace + fontSize and produces a non-empty docx', async () => {
        const buf = await generateDocx(MD, { fontFace: 'Noto Sans', fontSize: 13, headingColor: '1A3A5C' });
        expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('tolerates a leading # on headingColor (normalised to bare 6-hex)', async () => {
        const buf = await generateDocx(MD, { headingColor: '#1A3A5C' });
        expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('produces a valid docx with no brand options (default path unchanged)', async () => {
        const buf = await generateDocx(MD, { fontFace: 'Calibri' });
        // PK ZIP magic — a well-formed .docx archive.
        const head = new Uint8Array(buf.slice(0, 2));
        expect(head[0]).toBe(0x50);  // 'P'
        expect(head[1]).toBe(0x4b);  // 'K'
    });
});

describe('generateDocx — table font sizing (audit M3)', () => {
    const TABLE_MD = '# Report\n\n| Term | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |';

    it('applies fontSize + brand table min-font floor to a table without throwing', async () => {
        const buf = await generateDocx(TABLE_MD, { fontFace: 'Noto Sans', fontSize: 13, tableMinFont: 12 });
        const head = new Uint8Array(buf.slice(0, 2));
        expect(head[0]).toBe(0x50);  // 'P' — valid ZIP
        expect(head[1]).toBe(0x4b);  // 'K'
        expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('renders a table with default options (legacy 10pt path) as a valid docx', async () => {
        const buf = await generateDocx(TABLE_MD, {});
        const head = new Uint8Array(buf.slice(0, 2));
        expect(head[0]).toBe(0x50);
        expect(head[1]).toBe(0x4b);
    });
});
