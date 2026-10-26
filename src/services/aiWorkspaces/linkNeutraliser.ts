/**
 * Which links in a shared note may stay. No link syntax is parsed here: the occurrences and their positions come from
 * Obsidian's own metadata cache (wikilinks, markdown links and embeds alike), and each is replaced by its offset, last first.
 *
 * Fail closed. The cache is trusted only while it matches the text being packed:
 *  - every occurrence must find its `original` text at its offset (a stale cache fails this);
 *  - any link-like marker outside code and frontmatter that no occurrence covers is a link the cache missed (a note edited
 *    after it was cached, or syntax it does not report).
 * Either way the note is not packed (`links-unverified`) and the preview says so. Text inside fenced code is never a link to
 * the cache, so it is neither replaced nor counted. Frontmatter is not part of a pack and its links are not read.
 */
import { Result, ok, err } from '../../core/result';
import { nonBodyLines } from '../../utils/markdownRegions';

/** One link or embed as Obsidian reports it. */
export interface LinkOccurrence {
    /** The link target as written, without an alias (may carry a `#heading`) */
    link: string;
    /** The text shown for the link, when it has one */
    displayText?: string;
    /** The exact source text of the occurrence */
    original: string;
    start: number;
    end: number;
    /** An embed (`![[x]]`, `![](x)`) rather than a link */
    embed: boolean;
}

export interface LinkPolicy {
    /** Why a path may not be shared, or null when it may */
    reasonNotShareable: (path: string) => string | null;
    /** Resolve a link target written in `from` to a vault path, or null when it does not resolve */
    resolveLink: (link: string, from: string) => string | null;
}

export const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|pdf|docx?|pptx?|xlsx?|mp3|m4a|wav|mp4|mov|zip)$/i;

const EXTERNAL = /^(https?:|mailto:)/i;

/** What one occurrence becomes. */
export function replacementFor(o: LinkOccurrence, from: string, policy: LinkPolicy): string {
    const target = o.link.replace(/#.*$/, '').trim();
    if (target === '' || EXTERNAL.test(o.link.trim())) return o.original;
    const label = (o.displayText ?? '').trim() || target;
    if (ATTACHMENT_EXT.test(target)) return o.embed ? '[attachment not included]' : `${label} [attachment not included]`;
    const resolved = policy.resolveLink(target, from);
    // An embed that does not resolve is hidden; a plain link that does not resolve is the person's own text and stays.
    if (resolved === null) return o.embed ? '[not shared]' : o.original;
    if (ATTACHMENT_EXT.test(resolved)) return '[attachment not included]';
    if (policy.reasonNotShareable(resolved) === null) return o.embed ? label : o.original;
    return o.embed ? '[not shared]' : `${label} [not shared]`;
}

/** Link-like markers that must each lie inside some occurrence: `[[`, `![`, `](`. */
const MARKER = /\[\[|!\[|\]\(/g;

/**
 * The text with its links neutralised, or `links-unverified`. `occurrences === null` means the note has no usable cache.
 */
export function neutraliseByCache(text: string, from: string, occurrences: readonly LinkOccurrence[] | null, policy: LinkPolicy): Result<string> {
    if (occurrences === null) return err('links-unverified');
    const sorted = [...occurrences].sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const o of sorted) {
        if (!Number.isInteger(o.start) || !Number.isInteger(o.end) || o.start < previousEnd || o.end <= o.start || o.end > text.length) return err('links-unverified');
        if (text.slice(o.start, o.end) !== o.original) return err('links-unverified');
        previousEnd = o.end;
    }
    // Markers outside code and frontmatter that no occurrence covers.
    const lines = text.split('\n');
    const hidden = nonBodyLines(lines);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineStart = offset;
        offset += lines[i].length + 1;
        if (hidden[i]) continue;
        MARKER.lastIndex = 0;
        for (let m = MARKER.exec(lines[i]); m !== null; m = MARKER.exec(lines[i])) {
            const at = lineStart + m.index;
            if (!sorted.some((o) => at >= o.start && at < o.end)) return err('links-unverified');
        }
    }
    let out = text;
    for (let i = sorted.length - 1; i >= 0; i--) {
        const o = sorted[i];
        out = out.slice(0, o.start) + replacementFor(o, from, policy) + out.slice(o.end);
    }
    return ok(out);
}
