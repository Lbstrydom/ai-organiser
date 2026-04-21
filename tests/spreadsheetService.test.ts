import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
    extractSpreadsheet,
    MAX_ROWS,
    MAX_COLS,
    MAX_SHEETS,
    MAX_BUFFER_BYTES,
    MAX_OUTPUT_CHARS,
} from '../src/services/spreadsheetService';

// ── Helpers ───────────────────────────────────────────────────────────────

function buildXlsx(sheets: Record<string, unknown[][]>): ArrayBuffer {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, name);
    }
    // SheetJS `type: 'buffer'` returns a Node Buffer in node / Uint8Array in
    // browser. Either way its `.buffer` is an ArrayBuffer we can slice.
    const out: unknown = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    if (out instanceof ArrayBuffer) return out;
    const view = out as Uint8Array;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function buildCsv(text: string): ArrayBuffer {
    const buf = new TextEncoder().encode(text);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ── Basic round-trip ─────────────────────────────────────────────────────

describe('extractSpreadsheet — basic round-trip', () => {
    it('parses a 1-sheet xlsx with headers + body rows', () => {
        const buf = buildXlsx({
            Revenue: [
                ['Quarter', 'Revenue', 'Growth'],
                ['Q1', 1200000, '15%'],
                ['Q2', 1350000, '12.5%'],
            ],
        });
        const r = extractSpreadsheet(buf, 'finance.xlsx');
        expect(r.success).toBe(true);
        expect(r.sheets).toHaveLength(1);
        expect(r.sheets[0].name).toBe('Revenue');
        expect(r.sheets[0].headers).toEqual(['Quarter', 'Revenue', 'Growth']);
        expect(r.sheets[0].rowCount).toBe(2);
        expect(r.sheets[0].colCount).toBe(3);
        expect(r.sheets[0].rows).toEqual([
            ['Q1', '1200000', '15%'],
            ['Q2', '1350000', '12.5%'],
        ]);
        expect(r.sheets[0].truncated).toBe(false);
        expect(r.totalRows).toBe(2);
        expect(r.truncated).toBe(false);
        expect(r.markdown).toContain('# finance.xlsx');
        expect(r.markdown).toContain('### Sheet: Revenue (2 rows × 3 cols)');
        expect(r.markdown).toContain('| Quarter | Revenue | Growth |');
        expect(r.markdown).toContain('| Q1 | 1200000 | 15% |');
    });

    it('parses multiple sheets and concatenates in order', () => {
        const buf = buildXlsx({
            Alpha: [['A'], ['1']],
            Beta: [['B'], ['2']],
        });
        const r = extractSpreadsheet(buf, 'multi.xlsx');
        expect(r.sheets.map(s => s.name)).toEqual(['Alpha', 'Beta']);
        const alphaIdx = r.markdown.indexOf('Sheet: Alpha');
        const betaIdx = r.markdown.indexOf('Sheet: Beta');
        expect(alphaIdx).toBeGreaterThan(0);
        expect(betaIdx).toBeGreaterThan(alphaIdx);
    });

    it('handles empty sheet gracefully', () => {
        const buf = buildXlsx({ Blank: [] });
        const r = extractSpreadsheet(buf, 'empty.xlsx');
        expect(r.success).toBe(true);
        expect(r.sheets[0].rowCount).toBe(0);
        expect(r.markdown).toContain('_Empty sheet._');
    });
});

// ── CSV path ──────────────────────────────────────────────────────────────

describe('extractSpreadsheet — csv', () => {
    it('parses a csv buffer', () => {
        const buf = buildCsv('name,age\nAlice,30\nBob,25\n');
        const r = extractSpreadsheet(buf, 'people.csv');
        expect(r.success).toBe(true);
        expect(r.sheets[0].headers).toEqual(['name', 'age']);
        expect(r.sheets[0].rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    });

    it('escapes pipe characters inside cells', () => {
        const buf = buildCsv('col\n"a|b"\n');
        const r = extractSpreadsheet(buf, 'escape.csv');
        expect(r.markdown).toContain(String.raw`a\|b`);
    });
});

// ── Limits / truncation ───────────────────────────────────────────────────

describe('extractSpreadsheet — limits', () => {
    it('truncates rows beyond MAX_ROWS and flags the sheet', () => {
        const rows: unknown[][] = [['id']];
        for (let i = 0; i < MAX_ROWS + 50; i++) rows.push([i]);
        const buf = buildXlsx({ Big: rows });
        const r = extractSpreadsheet(buf, 'big.xlsx');
        expect(r.success).toBe(true);
        expect(r.sheets[0].rowCount).toBe(MAX_ROWS + 50); // original
        expect(r.sheets[0].rows.length).toBe(MAX_ROWS);    // truncated
        expect(r.sheets[0].truncated).toBe(true);
        expect(r.truncated).toBe(true);
        expect(r.markdown).toContain('— showing first');
    });

    it('truncates columns beyond MAX_COLS', () => {
        const header: unknown[] = [];
        for (let i = 0; i < MAX_COLS + 5; i++) header.push(`c${i}`);
        const buf = buildXlsx({ Wide: [header, header.map((_, i) => i)] });
        const r = extractSpreadsheet(buf, 'wide.xlsx');
        expect(r.sheets[0].colCount).toBe(MAX_COLS + 5);
        expect(r.sheets[0].headers.length).toBe(MAX_COLS);
        expect(r.sheets[0].rows[0].length).toBe(MAX_COLS);
        expect(r.sheets[0].truncated).toBe(true);
    });

    it('drops sheets beyond MAX_SHEETS', () => {
        const sheets: Record<string, unknown[][]> = {};
        for (let i = 0; i < MAX_SHEETS + 3; i++) {
            sheets[`s${i}`] = [['x'], [i]];
        }
        const buf = buildXlsx(sheets);
        const r = extractSpreadsheet(buf, 'many.xlsx');
        expect(r.sheets.length).toBe(MAX_SHEETS);
        expect(r.truncated).toBe(true);
        expect(r.markdown).toContain(`first ${MAX_SHEETS} of ${MAX_SHEETS + 3}`);
    });
});

// ── Error paths ───────────────────────────────────────────────────────────

describe('extractSpreadsheet — buffer-size gate (H3)', () => {
    it('rejects buffers larger than MAX_BUFFER_BYTES before parsing', () => {
        // Construct a buffer just over the limit — content doesn't need to
        // be a valid xlsx because the check runs before XLSX.read.
        const tooBig = new ArrayBuffer(MAX_BUFFER_BYTES + 1);
        const r = extractSpreadsheet(tooBig, 'adversarial.xlsx');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/exceeds .* MB limit/);
        expect(r.sheets).toEqual([]);
    });

    it('accepts buffers at exactly MAX_BUFFER_BYTES (boundary)', () => {
        // Still invalid as xlsx, but should get past the size gate and hit
        // parse-time error instead — proves the boundary is inclusive.
        const atLimit = new ArrayBuffer(MAX_BUFFER_BYTES);
        const r = extractSpreadsheet(atLimit, 'big-but-ok.xlsx');
        // Either parses as empty workbook or fails at parse time — never
        // fails at the size gate.
        if (!r.success) {
            expect(r.error).not.toMatch(/exceeds .* MB limit/);
        }
    });
});

describe('extractSpreadsheet — mid-sheet truncation (H8)', () => {
    it('emits partial rows + truncation marker when a single sheet exceeds output budget', () => {
        // Build one sheet large enough to exceed MAX_OUTPUT_CHARS on its own.
        // Each row ~100 chars × 2000 rows = ~200KB worth of markdown,
        // comfortably over 80KB MAX_OUTPUT_CHARS.
        const rows: unknown[][] = [['id', 'payload']];
        const payload = 'x'.repeat(80);
        for (let i = 0; i < 2000; i++) rows.push([i, payload]);
        const buf = buildXlsx({ Big: rows });
        const r = extractSpreadsheet(buf, 'big-single-sheet.xlsx');

        expect(r.success).toBe(true);
        expect(r.truncated).toBe(true);
        expect(r.markdown.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 200); // allow tiny overhead
        // Must contain header row + at least one data row (NOT empty).
        expect(r.markdown).toContain('| id | payload |');
        expect(r.markdown).toMatch(/\| 0 \| x+ \|/);
        // Must contain the explicit truncation marker.
        expect(r.markdown).toMatch(/rows truncated to stay within context budget/);
    });
});

describe('extractSpreadsheet — errors', () => {
    it('returns success=false for an unparseable buffer', () => {
        const garbage = new Uint8Array([0xFF, 0xFE, 0xFD, 0x00, 0x01]);
        const r = extractSpreadsheet(
            garbage.buffer.slice(0),
            'garbage.xlsx',
        );
        // Permissive parsers may accept garbage as an empty workbook; assert
        // we either error out OR return zero useful data — never a false
        // "success with ghost rows" signal.
        if (r.success) {
            expect(r.totalRows).toBe(0);
        } else {
            expect(r.error).toBeTruthy();
        }
    });
});

// ── Row coercion ──────────────────────────────────────────────────────────

describe('extractSpreadsheet — cell coercion', () => {
    it('coerces numbers and booleans to strings', () => {
        const buf = buildXlsx({
            Mix: [['n', 'b'], [42, true], [3.14, false]],
        });
        const r = extractSpreadsheet(buf, 'mix.xlsx');
        expect(r.sheets[0].rows).toEqual([
            ['42', 'true'],
            ['3.14', 'false'],
        ]);
    });

    it('pads short rows with empty strings for alignment', () => {
        const buf = buildXlsx({
            Ragged: [['a', 'b', 'c'], [1, 2], [9]],
        });
        const r = extractSpreadsheet(buf, 'ragged.xlsx');
        expect(r.sheets[0].rows[0]).toEqual(['1', '2', '']);
        expect(r.sheets[0].rows[1]).toEqual(['9', '', '']);
    });
});
