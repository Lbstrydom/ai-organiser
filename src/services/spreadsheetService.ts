/**
 * Spreadsheet Extraction Service
 *
 * Converts .xlsx / .csv / .xls binary buffers into structured markdown tables
 * so the LLM can reason about rows and columns instead of a flat text dump.
 *
 * Phase 3 of the sister-repo backport (`docs/plans/sister-backport-impl.md`).
 * Hard limits protect against OOM on pathological spreadsheets. Limits are
 * `const` (not settings) — they guard plugin stability, not user preference.
 */

import * as XLSX from 'xlsx';

/** One parsed worksheet. */
export interface SheetData {
    name: string;
    headers: string[];
    rows: string[][];
    rowCount: number;    // original row count (excluding header), BEFORE truncation
    colCount: number;    // original column count, BEFORE truncation
    truncated: boolean;  // true when this sheet hit MAX_ROWS or MAX_COLS
}

/** Result of extracting all sheets from a spreadsheet. */
export interface SpreadsheetResult {
    success: boolean;
    sheets: SheetData[];
    totalRows: number;
    truncated: boolean;   // true when ANY sheet was truncated, sheets were dropped, or markdown was capped
    markdown: string;     // All sheets rendered as markdown tables (capped by MAX_OUTPUT_CHARS)
    error?: string;
}

/**
 * Hard extraction limits. These guard the plugin against pathological inputs
 * (1M-row exports, adversarial sheet counts) and keep LLM context usable.
 *
 * `MAX_BUFFER_BYTES` is the pre-parse gate — SheetJS materialises the whole
 * workbook in memory on `XLSX.read()`, so the row/col/sheet caps below only
 * protect LLM context, not process memory. The byte gate stops obviously
 * adversarial files (>20 MB xlsx) before we ever allocate the workbook.
 * Audit R1 H3/H7 (2026-04-21).
 */
export const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_ROWS = 5_000;
export const MAX_COLS = 50;
export const MAX_SHEETS = 10;
export const MAX_OUTPUT_CHARS = 80_000;

/**
 * Extract structured data from xlsx/csv/xls files.
 *
 * Returns a `SpreadsheetResult` with per-sheet structured data AND a
 * markdown rendering suitable for LLM consumption. If the buffer cannot be
 * parsed at all, returns `success: false` with an error message. Partial
 * extraction (some sheets succeed, others fail) still returns `success: true`
 * with `truncated: true` and whatever was parsed.
 */
export function extractSpreadsheet(
    buffer: ArrayBuffer,
    fileName: string,
): SpreadsheetResult {
    // Audit R1 H3/H7: pre-parse size gate. SheetJS materialises the full
    // workbook on read, so the row/col/sheet/output caps below can't protect
    // process memory. Reject oversized buffers here before allocation.
    if (buffer.byteLength > MAX_BUFFER_BYTES) {
        const mbLimit = Math.round(MAX_BUFFER_BYTES / (1024 * 1024));
        return failResult(`Spreadsheet file exceeds ${mbLimit} MB limit (${Math.round(buffer.byteLength / (1024 * 1024))} MB)`);
    }

    let workbook: XLSX.WorkBook;
    try {
        // `type: 'array'` is the Uint8Array path and handles xlsx, xls, csv
        // automatically by magic-number sniffing.
        workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    } catch (err) {
        return failResult(err instanceof Error ? err.message : 'Failed to parse spreadsheet');
    }

    const sheetNames = workbook.SheetNames;
    if (sheetNames.length === 0) {
        return failResult('Spreadsheet contains no sheets');
    }

    const sheetsDropped = sheetNames.length > MAX_SHEETS;
    const takeSheets = sheetNames.slice(0, MAX_SHEETS);

    const sheets: SheetData[] = [];
    let totalRows = 0;
    let anyTruncated = sheetsDropped;

    for (const sheetName of takeSheets) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const extracted = extractSheet(sheet, sheetName);
        sheets.push(extracted);
        if (extracted.truncated) anyTruncated = true;
        totalRows += Math.min(extracted.rowCount, MAX_ROWS);
    }

    const { markdown, capped } = renderMarkdown(sheets, fileName, sheetsDropped, sheetNames.length);
    if (capped) anyTruncated = true;

    return {
        success: true,
        sheets,
        totalRows,
        truncated: anyTruncated,
        markdown,
    };
}

/** Construct a failure result in one place to keep extractSpreadsheet
 *  cognitive complexity under the SonarQube ceiling. */
function failResult(error: string): SpreadsheetResult {
    return { success: false, sheets: [], totalRows: 0, truncated: false, markdown: '', error };
}

/** Extract one sheet's rows/headers/counts with all the aoa→SheetData
 *  shaping. Kept out of extractSpreadsheet() so the loop body stays
 *  straight-line and the overall complexity stays within limits. */
function extractSheet(sheet: XLSX.WorkSheet, sheetName: string): SheetData {
    // `header: 1` → array-of-arrays. `defval: ''` → empty cells become ''
    // instead of undefined so rows align.
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
    });

    if (aoa.length === 0) {
        return { name: sheetName, headers: [], rows: [], rowCount: 0, colCount: 0, truncated: false };
    }

    const originalColCount = aoa.reduce(
        (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
        0,
    );
    const originalRowCount = aoa.length - 1; // excluding header

    const headers = stringifyRow(aoa[0] ?? []).slice(0, MAX_COLS);
    const bodyRowsRaw = aoa.slice(1, 1 + MAX_ROWS);
    const rows = bodyRowsRaw.map(r => stringifyRow(r).slice(0, MAX_COLS));

    // Pad short rows with '' so each row matches the header length —
    // markdown tables require aligned columns.
    const colLimit = Math.min(originalColCount, MAX_COLS);
    for (const row of rows) {
        while (row.length < colLimit) row.push('');
    }
    while (headers.length < colLimit) headers.push('');

    return {
        name: sheetName,
        headers,
        rows,
        rowCount: originalRowCount,
        colCount: originalColCount,
        truncated: originalRowCount > MAX_ROWS || originalColCount > MAX_COLS,
    };
}

/** Coerce an arbitrary row of cells to trimmed strings for stable rendering. */
function stringifyRow(row: unknown[]): string[] {
    return row.map(cell => {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'string') return cell.trim();
        if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
        // Dates arrive as Date objects when cellDates is enabled — otherwise
        // as serial numbers. We take the permissive branch and rely on
        // String() so either shape degrades gracefully.
        if (cell instanceof Date) return cell.toISOString();
        // Anything else (objects from formula/rich text paths) — JSON
        // approximation avoids the default "[object Object]" stringification
        // that would lose information in the markdown table.
        if (typeof cell === 'object') {
            try {
                return JSON.stringify(cell);
            } catch {
                return '';
            }
        }
        return '';
    });
}

/**
 * Render sheets to a combined markdown document, stopping cleanly when the
 * output would exceed MAX_OUTPUT_CHARS. Returns whether capping occurred so
 * callers can mark the overall result as truncated.
 */
function renderMarkdown(
    sheets: SheetData[],
    fileName: string,
    sheetsDropped: boolean,
    originalSheetCount: number,
): { markdown: string; capped: boolean } {
    if (sheets.length === 0) {
        return { markdown: `# ${fileName}\n\n_No sheets._`, capped: false };
    }

    const chunks: string[] = [`# ${fileName}`];
    let charCount = chunks[0].length + 1;
    let capped = false;

    if (sheetsDropped) {
        const note = `\n_Showing first ${sheets.length} of ${originalSheetCount} sheets; ${originalSheetCount - sheets.length} dropped._`;
        chunks.push(note);
        charCount += note.length;
    }

    for (const sheet of sheets) {
        const remaining = MAX_OUTPUT_CHARS - charCount - 2;
        if (remaining <= 0) {
            chunks.push('\n\n_[...output truncated — remaining sheets omitted to stay within context budget]_');
            capped = true;
            break;
        }
        // Audit R1 H8: render sheet with per-sheet char budget so a single
        // oversized first sheet no longer produces an empty result. We
        // render into `remaining` budget and emit a mid-sheet truncation
        // marker when rows get dropped.
        const { block, cappedInSheet } = renderSheetBlockCapped(sheet, remaining);
        chunks.push('\n\n' + block);
        charCount += block.length + 2;
        if (cappedInSheet) {
            capped = true;
            // Stop after a mid-sheet truncation — subsequent sheets won't
            // fit either, and emitting their headers with no rows is noise.
            chunks.push('\n\n_[...output truncated — remaining sheets omitted to stay within context budget]_');
            break;
        }
    }

    return { markdown: chunks.join(''), capped };
}

/** Render a sheet into at most `budgetChars` characters. Drops rows from
 *  the end and emits an inline truncation marker if the full block would
 *  exceed the budget. Audit R1 H8. */
function renderSheetBlockCapped(sheet: SheetData, budgetChars: number): { block: string; cappedInSheet: boolean } {
    const full = renderSheetBlock(sheet);
    if (full.length <= budgetChars) return { block: full, cappedInSheet: false };

    // Over budget — rebuild progressively, dropping trailing rows until
    // the output fits. Keep the header row(s) regardless so the table
    // remains valid markdown and column labels stay visible.
    const sizeLabel = sheet.truncated
        ? `${sheet.rowCount} rows × ${sheet.colCount} cols — showing first ${Math.min(sheet.rowCount, MAX_ROWS)}×${Math.min(sheet.colCount, MAX_COLS)}`
        : `${sheet.rowCount} rows × ${sheet.colCount} cols`;
    const header = `### Sheet: ${escapeMd(sheet.name)} (${sizeLabel})\n\n`;
    const truncMarker = '\n\n_[...rows truncated to stay within context budget]_';
    const overheadFixed = header.length + truncMarker.length;

    const paddedHeaders = padHeaders(sheet.headers, sheet.rows);
    const headerLines = [
        `| ${paddedHeaders.map(escapeCell).join(' | ')} |`,
        `| ${paddedHeaders.map(() => '---').join(' | ')} |`,
    ].join('\n') + '\n';
    let used = overheadFixed + headerLines.length;

    const emittedRows: string[] = [];
    for (const row of sheet.rows) {
        const padded = [...row];
        while (padded.length < paddedHeaders.length) padded.push('');
        const line = `| ${padded.map(escapeCell).join(' | ')} |`;
        if (used + line.length + 1 > budgetChars) break;
        emittedRows.push(line);
        used += line.length + 1;
    }

    const block = header + headerLines + emittedRows.join('\n') + truncMarker;
    return { block, cappedInSheet: true };
}

function padHeaders(headers: string[], rows: string[][]): string[] {
    const colCount = Math.max(headers.length, ...rows.map(r => r.length), 1);
    const out = [...headers];
    while (out.length < colCount) out.push(`Col${out.length + 1}`);
    return out;
}

function renderSheetBlock(sheet: SheetData): string {
    const sizeLabel = sheet.truncated
        ? `${sheet.rowCount} rows × ${sheet.colCount} cols — showing first ${Math.min(sheet.rowCount, MAX_ROWS)}×${Math.min(sheet.colCount, MAX_COLS)}`
        : `${sheet.rowCount} rows × ${sheet.colCount} cols`;
    const header = `### Sheet: ${escapeMd(sheet.name)} (${sizeLabel})`;

    if (sheet.rows.length === 0 && sheet.headers.length === 0) {
        return `${header}\n\n_Empty sheet._`;
    }

    const rendered = renderTable(sheet.headers, sheet.rows);
    return `${header}\n\n${rendered}`;
}

function renderTable(headers: string[], rows: string[][]): string {
    const paddedHeaders = padHeaders(headers, rows);
    const colCount = paddedHeaders.length;
    const lines: string[] = [
        `| ${paddedHeaders.map(escapeCell).join(' | ')} |`,
        `| ${paddedHeaders.map(() => '---').join(' | ')} |`,
    ];
    for (const row of rows) {
        const padded = [...row];
        while (padded.length < colCount) padded.push('');
        lines.push(`| ${padded.map(escapeCell).join(' | ')} |`);
    }
    return lines.join('\n');
}

function escapeCell(cell: string): string {
    // Collapse newlines (tables don't survive them), escape pipes.
    return cell.replaceAll(/\r?\n/g, ' ').replaceAll('|', String.raw`\|`);
}

function escapeMd(s: string): string {
    return s.replaceAll(/[*_`]/g, c => `\\${c}`);
}
