/**
 * The generated daily-audio listen line, found the way the plugin wrote it and nowhere else.
 *
 * `newsletterService.injectAudioEmbedIntoDigest` writes exactly `🎧 **Listen:** ![[brief-<date>-<hash>.mp3]]`
 * on its own line under the digest title. Selection (what may be offered) and the tidy (what may be
 * rewritten) must agree on what counts, so both ask here. A line inside a fenced code block, in a
 * quotation or indented as code is an EXAMPLE someone typed, never the plugin's embed. Pure.
 */

export interface EmbedLine {
    /** Offset of the line start in the text. */
    start: number;
    /** Offset just after the line's end, line break included. */
    end: number;
    /** The embedded file name exactly as written (a bare name). */
    name: string;
}

const LINE = /^ {0,3}🎧[ \t]*\*\*Listen:\*\*[ \t]*!\[\[(brief-[^\]|/\n]+\.(?:wav|mp3))\]\][ \t]*\r?$/;

/** A fence opener, optionally behind list markers (`- ````, `1. ~~~`): code inside a list item is still code. */
const OPEN = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/;
const CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t\r]*$/;

/** Every generated listen line outside fenced code and HTML comments, in order. */
export function generatedEmbedLines(content: string): EmbedLine[] {
    const out: EmbedLine[] = [];
    let fence: { char: string; length: number } | null = null;
    let inComment = false;
    let offset = 0;
    for (const raw of content.split('\n')) {
        const start = offset;
        offset += raw.length + 1;
        if (fence === null) {
            const run = OPEN.exec(raw);
            // CommonMark: a backtick fence cannot carry a backtick in its info string.
            if (!inComment && run && !(run[1][0] === '`' && run[2].includes('`'))) { fence = { char: run[1][0], length: run[1].length }; continue; }
        } else {
            const close = CLOSE.exec(raw);
            if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
            continue;
        }
        // An HTML comment can span lines; nothing inside it is rendered, so nothing inside it is the embed.
        const opens = raw.lastIndexOf('<!--');
        const closes = raw.lastIndexOf('-->');
        if (inComment) { if (closes >= 0) inComment = false; continue; }
        if (opens > closes) { inComment = true; continue; }
        const m = LINE.exec(raw);
        if (m) out.push({ start, end: Math.min(offset, content.length), name: m[1] });
    }
    return out;
}
