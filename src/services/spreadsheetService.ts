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
 */
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
    let workbook: XLSX.WorkBook;
    try {
        // `type: 'array'` is the Uint8Array path and handles xlsx, xls, csv
        // automatically by magic-number sniffing.
        workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    } catch (err) {
        return {
            success: false,
            sheets: [],
            totalRows: 0,
            truncated: false,
            markdown: '',
            error: err instanceof Error ? err.message : 'Failed to parse spreadsheet',
        };
    }

    const sheetNames = workbook.SheetNames;
    if (sheetNames.length === 0) {
        return {
            success: false,
            sheets: [],
            totalRows: 0,
            truncated: false,
            markdown: '',
            error: 'Spreadsheet contains no sheets',
        };
    }

    const sheetsDropped = sheetNames.length > MAX_SHEETS;
    const takeSheets = sheetNames.slice(0, MAX_SHEETS);

    const sheets: SheetData[] = [];
    let totalRows = 0;
    let anyTruncated = sheetsDropped;

    for (const sheetName of takeSheets) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;

        // `header: 1` → array-of-arrays. `defval: ''` → empty cells become ''
        // instead of undefined so rows align.
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            defval: '',
            blankrows: false,
        });

        if (aoa.length === 0) {
            // Still record the sheet so the markdown explains why it's empty —
            // better LLM signal than silently skipping.
            sheets.push({
                name: sheetName,
                headers: [],
                rows: [],
                rowCount: 0,
                colCount: 0,
                truncated: false,
            });
            continue;
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

        const sheetTruncated =
            originalRowCount > MAX_ROWS || originalColCount > MAX_COLS;
        if (sheetTruncated) anyTruncated = true;

        totalRows += Math.min(originalRowCount, MAX_ROWS);
        sheets.push({
            name: sheetName,
            headers,
            rows,
            rowCount: originalRowCount,
            colCount: originalColCount,
            truncated: sheetTruncated,
        });
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
        const block = renderSheetBlock(sheet);
        if (charCount + block.length + 2 > MAX_OUTPUT_CHARS) {
            chunks.push('\n\n_[...output truncated — remaining sheets omitted to stay within context budget]_');
            capped = true;
            break;
        }
        chunks.push('\n\n' + block);
        charCount += block.length + 2;
    }

    return { markdown: chunks.join(''), capped };
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
    // If there are rows but no headers, synthesize Col1, Col2, ...
    const colCount = Math.max(headers.length, ...rows.map(r => r.length), 1);
    const paddedHeaders = [...headers];
    while (paddedHeaders.length < colCount) paddedHeaders.push(`Col${paddedHeaders.length + 1}`);

    const lines: string[] = [];
    lines.push(`| ${paddedHeaders.map(escapeCell).join(' | ')} |`);
    lines.push(`| ${paddedHeaders.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
        const padded = [...row];
        while (padded.length < colCount) padded.push('');
        lines.push(`| ${padded.map(escapeCell).join(' | ')} |`);
    }
    return lines.join('\n');
}

function escapeCell(cell: string): string {
    // Collapse newlines (tables don't survive them), escape pipes.
    return cell.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function escapeMd(s: string): string {
    return s.replace(/[*_`]/g, c => `\\${c}`);
}
