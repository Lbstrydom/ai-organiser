/**
 * Synthetic Excalidraw drawing notes, modelled on the layout the Excalidraw plugin (2.29) really
 * writes: frontmatter with blank lines inside the fences, a banner, `## Text Elements`, then `%%` +
 * `## Drawing` + a hard-wrapped blob that itself contains blank lines. No vault content.
 */

export const BANNER = "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'.";

/** The first characters of the synthetic blob; assert a request does not contain this. */
export const BLOB_MARK = 'N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZ';
export const BLOB_PROBE = BLOB_MARK.slice(0, 20);

/** Blob-like base64 with a blank line every 256 chars, like the plugin writes. */
export function blob(chars: number): string {
    let s = '';
    while (s.length < chars) s += BLOB_MARK;
    const out: string[] = [];
    for (let i = 0; i < chars; i += 256) out.push(s.slice(i, Math.min(i + 256, chars)));
    return out.join('\n\n');
}

export interface DrawingOptions {
    /** Text elements exactly as stored, id included: `Intake ^64GA6tr1`. */
    elements?: string[];
    /** `Embedded Files` section lines: `f1: [[pic.png]]`. */
    embeds?: string[];
    eol?: string;
    /** Store the drawing as an uncompressed JSON block. */
    json?: boolean;
    blobChars?: number;
    omitTextSection?: boolean;
    /** User prose the plugin keeps between the frontmatter and its data. */
    preface?: string;
    /** Extra frontmatter lines (e.g. a long user-added property). */
    extraFrontmatter?: string[];
    /** Write the key quoted (`"excalidraw-plugin": parsed`). */
    quotedKey?: boolean;
}

export const DEFAULT_ELEMENTS = ['Intake ^64GA6tr1', 'Decision ^KUuV7DH0'];

export function drawingNote(o: DrawingOptions = {}): string {
    const eol = o.eol ?? '\n';
    const elements = o.elements ?? DEFAULT_ELEMENTS;
    const parts = [
        '---', '', o.quotedKey ? '"excalidraw-plugin": parsed' : 'excalidraw-plugin: parsed', 'tags: [excalidraw]',
        ...(o.extraFrontmatter ?? []), '', '---',
        BANNER, '',
        ...(o.preface !== undefined ? [o.preface, ''] : []),
        '# Excalidraw Data', '',
    ];
    if (!o.omitTextSection) {
        parts.push('## Text Elements');
        for (const e of elements) parts.push(e, '');
        parts.push('');
    }
    if (o.embeds) parts.push('## Embedded Files', ...o.embeds, '');
    parts.push('%%', '## Drawing');
    if (o.json) {
        parts.push('```json', '{"type":"excalidraw","elements":[{"id":"a","type":"text","text":"SECRET-JSON-TEXT"}]}', '```');
    } else {
        parts.push('```compressed-json', blob(o.blobChars ?? 1200), '```');
    }
    parts.push('%%');
    return parts.join(eol);
}
