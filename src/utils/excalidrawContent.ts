/**
 * Excalidraw drawing notes — the readable part of a note that is really a drawing.
 *
 * The Excalidraw plugin stores a drawing as an ordinary `.md` file: a small frontmatter
 * block (`excalidraw-plugin: parsed`), optional user prose, a "Text Elements" section holding
 * the words in the drawing, and a large compressed base64 blob (or a JSON block) inside `%%`
 * comment fences. Anything that feeds a note's raw text to a model or an index would embed
 * that blob.
 *
 * Pure and dependency-free. Apply ONLY where the text is consumed and discarded (a model
 * prompt, an embedding request): never to a string that is later written back to the note.
 * A note that is not a recognised drawing is returned as the SAME string.
 */

/**
 * Upper bound on how far into the file the frontmatter block may extend. The plugin writes a
 * few lines; the bound only keeps a file that opens with `---` and never closes it from being
 * scanned to its end.
 */
const FRONTMATTER_SCAN_CHARS = 262144;

const FRONTMATTER_KEY = /^["']?excalidraw-plugin["']?[ \t]*:/;
const DRAWING_NAME = /\.excalidraw\.md$/i;
/** Structural marker used when the name says "drawing" but the frontmatter is missing or mangled. */
const DRAWING_STRUCTURE = /^#{1,2} Drawing[ \t]*\r?\n```(?:compressed-)?json/m;
const DATA_HEADING = /^#{1,2} Excalidraw Data[ \t]*\r?$/gm;
const TEXT_ELEMENTS_HEADING = /^#{1,2} Text Elements[ \t]*\r?$/gm;
const EMBEDDED_FILES_HEADING = /^#{1,2} Embedded Files[ \t]*\r?$/gm;
/** The plugin's own section titles that end a section. Any other heading-looking line is label content. */
const SECTION_TITLES = new Set(['element links', 'embedded files', 'drawing', 'text elements']);
const HEADING_LINE = /^#{1,2}[ \t]+(.+?)[ \t]*$/;
/** Opener of the drawing data block: where the blob starts. */
const BLOB_FENCE = /^```(?:compressed-)?json/;
/** The banner the plugin writes above its data; not user content. */
const BANNER_LINE = /^==⚠.*EXCALIDRAW VIEW/;
/** The block id the plugin appends to a text element: whitespace, `^`, 8 characters (the plugin parses it the same way). */
const BLOCK_ID = /\s\^[A-Za-z0-9_-]{8}[ \t]*$/;

export interface ExcalidrawParts {
    /** The useful text of the drawing: user prose above the data, then the words in the drawing (block ids stripped). May be ''. */
    text: string;
    /** Trimmed body of the "Embedded Files" section (small `id: [[path]]` lines); '' when absent. Never the blob. */
    embeds: string;
}

/** Lines of `text` starting at `from`, without their line terminators (a trailing CR is dropped). */
function* linesFrom(text: string, from: number): Generator<string> {
    let pos = from;
    const len = text.length;
    while (pos <= len) {
        let nl = text.indexOf('\n', pos);
        if (nl === -1) nl = len;
        let line = text.slice(pos, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
        pos = nl + 1;
    }
}

function endsSection(line: string): boolean {
    if (line === '%%') return true;
    if (BLOB_FENCE.test(line)) return true;
    const heading = HEADING_LINE.exec(line);
    return heading !== null && SECTION_TITLES.has(heading[1].toLowerCase());
}

/** First match of a global multiline `heading` regex at or after `from`, or null. */
function findHeading(text: string, heading: RegExp, from: number): RegExpExecArray | null {
    heading.lastIndex = from;
    return heading.exec(text);
}

/**
 * The leading frontmatter block: where it ends (index just past its closing fence line) and
 * whether it carries the plugin's key. `null` when the text does not open with a closed block.
 */
function readFrontmatter(text: string): { end: number; hasKey: boolean } | null {
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const limit = Math.min(text.length, start + FRONTMATTER_SCAN_CHARS);
    let pos = start;
    let first = true;
    let hasKey = false;
    while (pos < limit) {
        let nl = text.indexOf('\n', pos);
        if (nl === -1) nl = text.length;
        const line = text.slice(pos, nl).replace(/\r$/, '');
        if (first) {
            if (line.trim() !== '---') return null;
            first = false;
        } else if (line.trim() === '---') {
            return { end: Math.min(nl + 1, text.length), hasKey };
        } else if (FRONTMATTER_KEY.test(line)) {
            hasKey = true;
        }
        pos = nl + 1;
    }
    return null; // never closed inside the bound: not a frontmatter block we can trust
}

/**
 * Recognise a drawing note. Primary predicate is the plugin's own: the `excalidraw-plugin`
 * frontmatter key. The `.excalidraw.md` name alone is NOT enough (it is only the plugin's
 * default file name); it counts only together with the drawing-data structure.
 */
export function isExcalidrawNote(text: string, path?: string): boolean {
    if (readFrontmatter(text)?.hasKey === true) return true;
    return path !== undefined && DRAWING_NAME.test(path) && DRAWING_STRUCTURE.test(text);
}

/** User prose between the frontmatter and the plugin's data heading (the plugin preserves it), banner removed. */
function extractPreface(text: string, bodyStart: number, dataStart: number): string {
    if (dataStart <= bodyStart) return '';
    return text
        .slice(bodyStart, dataStart)
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => !BANNER_LINE.test(l))
        .join('\n')
        .trim();
}

function extractSectionLines(text: string, heading: RegExpExecArray | null): string[] {
    if (!heading) return [];
    const out: string[] = [];
    // The match ends just before the heading line's terminator; +1 steps over the LF.
    for (const line of linesFrom(text, heading.index + heading[0].length + 1)) {
        if (endsSection(line)) break;
        out.push(line);
    }
    return out;
}

/**
 * Split a recognised drawing into its useful parts, or `null` when the note is not a drawing.
 * A recognised drawing without a Text Elements section yields no words — never the blob.
 */
export function excalidrawIndexParts(text: string, path?: string): ExcalidrawParts | null {
    if (!isExcalidrawNote(text, path)) return null;

    // Headings are looked up inside the plugin's data region when it is marked, so a user's own
    // "## Text Elements" in the prose above is not mistaken for the generated section.
    const bodyStart = readFrontmatter(text)?.end ?? 0;
    const data = findHeading(text, DATA_HEADING, bodyStart);
    const regionStart = data ? data.index : bodyStart;

    const preface = data ? extractPreface(text, bodyStart, data.index) : '';
    const words = extractSectionLines(text, findHeading(text, TEXT_ELEMENTS_HEADING, regionStart))
        .map((line) => line.replace(BLOCK_ID, '').trimEnd())
        .filter((line) => line.trim() !== '')
        .join('\n');
    const embeds = extractSectionLines(text, findHeading(text, EMBEDDED_FILES_HEADING, regionStart))
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join('\n');

    return { text: preface && words ? `${preface}\n\n${words}` : preface || words, embeds };
}

/**
 * The text a model or an index should see for a note: the drawing's words for a recognised
 * drawing, the unchanged input (same string) for everything else.
 */
export function toModelText(text: string, path?: string): string {
    const parts = excalidrawIndexParts(text, path);
    return parts === null ? text : parts.text;
}
