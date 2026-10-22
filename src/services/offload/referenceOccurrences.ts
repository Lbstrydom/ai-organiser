/**
 * Typed reference occurrences for the Drive offload. Pure: no vault access.
 *
 * For one referrer (a note or a canvas) and one target file, `findOccurrences` returns every place
 * that refers to the target, with the exact character span and what kind of reference it is. Each
 * kind has a defined conversion into a link to the Drive copy (`renderLink`). Anything that cannot
 * be classified is reported as `unsupported`, which makes the whole file ineligible: the offload
 * never guesses how to rewrite something it does not understand.
 *
 * Fenced code and inline code are never rewritten (and never counted as a reference).
 */
import { Result, ok, err } from '../../core/result';
import { nonBodyLines } from '../../utils/markdownRegions';
import { formatFileSize } from '../embedScanService';

export type OccurrenceKind =
    | 'wikilink'
    | 'wikilink-embed'
    | 'markdown-link'
    | 'markdown-embed'
    | 'canvas-file'
    | 'unsupported';

export type UnsupportedReason = 'frontmatter' | 'html' | 'reference-definition' | 'canvas-text-node';

export interface Occurrence {
    referrerPath: string;
    kind: OccurrenceKind;
    /** Character offsets into the referrer text (`end` exclusive). Zero for canvas nodes. */
    start: number;
    end: number;
    /** The exact source text of the occurrence (a node id for a canvas node) */
    original: string;
    /** Link alias (wikilink) or link text / alt (markdown), when the user wrote one */
    display?: string;
    /** Heading, block or `page=` subpath */
    subpath?: string;
    /** Canvas node id */
    nodeId?: string;
    reason?: UnsupportedReason;
}

export interface ScanTarget {
    path: string;
    name: string;
    /** Resolve link text written in `referrerPath` to a vault path, or null */
    resolve: (linktext: string, referrerPath: string) => string | null;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MD_LINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const HTML_TAG = /<(?:img|embed|iframe|object|a|source|video|audio)\b[^>]*>/gi;
const REF_DEFINITION = /^\s{0,3}\[[^\]\n]+\]:\s*\S+/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** Blank out inline code spans (same length, so offsets stay valid). */
function maskInlineCode(line: string): string {
    return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length));
}

function mentionsTarget(haystack: string, target: ScanTarget): boolean {
    const lower = haystack.toLowerCase();
    const name = target.name.toLowerCase();
    return lower.includes(name) || lower.includes(encodeURIComponent(target.name).toLowerCase()) || lower.includes(name.replace(/ /g, '%20'));
}

function splitAlias(inner: string): { link: string; alias?: string } {
    // Inside a table cell the separator is written `\|`.
    const m = /\\?\|/.exec(inner);
    if (!m) return { link: inner };
    return { link: inner.slice(0, m.index), alias: inner.slice(m.index + m[0].length) };
}

function splitSubpath(link: string): { path: string; subpath?: string } {
    const hash = link.indexOf('#');
    return hash === -1 ? { path: link } : { path: link.slice(0, hash), subpath: link.slice(hash + 1) };
}

function decodeDest(raw: string): string {
    let dest = raw.trim();
    const title = /^(<[^>]*>|\S+)\s+"[^"]*"$/.exec(dest);
    if (title) dest = title[1];
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
    try {
        return decodeURIComponent(dest);
    } catch {
        return dest;
    }
}

/** Occurrences of the target in a Markdown note. */
function findInMarkdown(referrerPath: string, text: string, target: ScanTarget): Occurrence[] {
    const out: Occurrence[] = [];
    const lines = text.split('\n');
    const hidden = nonBodyLines(lines);
    // Frontmatter is hidden for fences too; tell the two apart by position.
    let frontmatterEnd = -1;
    if (lines[0]?.trim() === '---') {
        for (let j = 1; j < lines.length; j++) if (lines[j].trim() === '---' || lines[j].trim() === '...') { frontmatterEnd = j; break; }
    }
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineStart = offset;
        offset += line.length + 1;
        const inFrontmatter = frontmatterEnd >= 0 && i <= frontmatterEnd;
        if (hidden[i] && !inFrontmatter) continue; // fenced code
        const work = inFrontmatter ? line : maskInlineCode(line);

        const found: Occurrence[] = [];
        for (const m of work.matchAll(WIKILINK)) {
            const { link, alias } = splitAlias(m[2]);
            const { path, subpath } = splitSubpath(link.trim());
            if (path === '' || target.resolve(path, referrerPath) !== target.path) continue;
            found.push({
                referrerPath,
                kind: m[1] ? 'wikilink-embed' : 'wikilink',
                start: lineStart + (m.index ?? 0),
                end: lineStart + (m.index ?? 0) + m[0].length,
                original: m[0],
                display: alias?.trim() || undefined,
                subpath,
            });
        }
        for (const m of work.matchAll(MD_LINK)) {
            const dest = decodeDest(m[3]);
            if (EXTERNAL.test(dest)) continue;
            const { path, subpath } = splitSubpath(dest);
            if (path === '' || target.resolve(path, referrerPath) !== target.path) continue;
            found.push({
                referrerPath,
                kind: m[1] ? 'markdown-embed' : 'markdown-link',
                start: lineStart + (m.index ?? 0),
                end: lineStart + (m.index ?? 0) + m[0].length,
                original: m[0],
                display: m[2].trim() || undefined,
                subpath,
            });
        }
        // Constructs the rewrite does not understand but that still refer to the file.
        for (const m of work.matchAll(HTML_TAG)) {
            if (!mentionsTarget(m[0], target)) continue;
            found.push({ referrerPath, kind: 'unsupported', start: lineStart + (m.index ?? 0), end: lineStart + (m.index ?? 0) + m[0].length, original: m[0], reason: 'html' });
        }
        if (!inFrontmatter && REF_DEFINITION.test(work) && mentionsTarget(work, target)) {
            found.push({ referrerPath, kind: 'unsupported', start: lineStart, end: lineStart + line.length, original: line, reason: 'reference-definition' });
        }
        if (inFrontmatter) {
            // A link in a property is a real link to Obsidian, but rewriting YAML is not safe.
            for (const occ of found) if (occ.kind !== 'unsupported') { occ.kind = 'unsupported'; occ.reason = 'frontmatter'; }
        }
        found.sort((a, b) => a.start - b.start);
        out.push(...found);
    }
    return out;
}

/** Occurrences of the target in a canvas: `file` nodes, and links hiding in text nodes. */
function findInCanvas(referrerPath: string, text: string, target: ScanTarget): Result<Occurrence[]> {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return err('canvas-unreadable');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return err('canvas-unreadable');
    const nodes = (data as { nodes?: unknown }).nodes;
    if (nodes === undefined) return ok([]);
    if (!Array.isArray(nodes)) return err('canvas-unreadable');
    const out: Occurrence[] = [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as { id?: unknown; type?: unknown; file?: unknown; subpath?: unknown; text?: unknown };
        const nodeId = typeof n.id === 'string' ? n.id : '';
        if (n.type === 'file' && typeof n.file === 'string') {
            if (n.file === target.path || target.resolve(n.file, referrerPath) === target.path) {
                out.push({ referrerPath, kind: 'canvas-file', start: 0, end: 0, original: nodeId, nodeId, subpath: typeof n.subpath === 'string' ? n.subpath : undefined });
            }
        } else if (n.type === 'text' && typeof n.text === 'string') {
            const inner = findInMarkdown(referrerPath, n.text, target);
            for (const occ of inner) out.push({ ...occ, kind: 'unsupported', start: 0, end: 0, nodeId, reason: 'canvas-text-node' });
        }
    }
    return ok(out);
}

/** Every occurrence of `target` in one referrer. `err('canvas-unreadable')` for a canvas that cannot be parsed. */
export function findOccurrences(referrerPath: string, text: string, extension: 'md' | 'canvas', target: ScanTarget): Result<Occurrence[]> {
    return extension === 'canvas' ? findInCanvas(referrerPath, text, target) : ok(findInMarkdown(referrerPath, text, target));
}

/** True when any occurrence cannot be rewritten. */
export function hasUnsupported(occurrences: readonly Occurrence[]): boolean {
    return occurrences.some((o) => o.kind === 'unsupported');
}

// ─── Conversion ──────────────────────────────────────────────────────────────

export interface LinkInfo {
    url: string;
    fileName: string;
    sizeBytes: number;
}

/** `PDF`, `PNG` ... from the file name. */
export function typeLabel(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot === -1 ? 'FILE' : fileName.slice(dot + 1).toUpperCase();
}

function escapeLabel(label: string): string {
    return label.replace(/\\/g, '\\\\').replace(/[[\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ').trim();
}

/** Image size hints (`|300`, `|300x200`) are not link text. */
function isSizeHint(alias: string): boolean {
    return /^\d+(?:x\d+)?$/.test(alias.trim());
}

function pageOf(subpath: string | undefined): number | null {
    const m = /(?:^|&)page=(\d+)/.exec(subpath ?? '');
    return m ? Number(m[1]) : null;
}

/** The Markdown that replaces a Markdown occurrence. */
export function renderLink(occ: Occurrence, info: LinkInfo): string {
    const embed = occ.kind === 'wikilink-embed' || occ.kind === 'markdown-embed';
    const page = pageOf(occ.subpath);
    let label: string;
    if (occ.display && !(embed && occ.kind === 'wikilink-embed' && isSizeHint(occ.display))) {
        label = occ.display;
    } else if (embed) {
        const pagePart = page ? ` (page ${page})` : '';
        label = `${info.fileName} (${typeLabel(info.fileName)}, ${formatFileSize(info.sizeBytes)})${pagePart} — open in Drive`;
    } else {
        const heading = occ.subpath && page === null ? ` (${occ.subpath})` : page ? ` (page ${page})` : '';
        label = `${info.fileName}${heading}`;
    }
    return `[${escapeLabel(label)}](${info.url})`;
}

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/** Apply non-overlapping edits to a text. Throws on overlap, which would mean a parser bug. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    let cursor = 0;
    let out = '';
    for (const e of sorted) {
        if (e.start < cursor || e.end < e.start || e.end > text.length) throw new Error('overlapping or out-of-range edit');
        out += text.slice(cursor, e.start) + e.text;
        cursor = e.end;
    }
    return out + text.slice(cursor);
}
