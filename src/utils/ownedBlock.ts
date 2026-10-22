/**
 * The one owned-block grammar. A "block" is text the plugin owns inside a note the user also edits,
 * delimited by a start marker and an end marker that each fill their own line.
 *
 * Shared by the Drive hub note and the `AGENTS.md` instructions block, so there is one parser:
 *  - fenced code and frontmatter are ignored (a marker shown as an example is not a block);
 *  - a marker counts only when it fills its line (the same text in a sentence is prose);
 *  - a duplicate, missing, out-of-order or nested marker is `marker-conflict` and nothing is written;
 *  - appending after an unclosed code fence is refused (the block could never be found again);
 *  - replacing is byte-exact, so text outside the block is never touched.
 */
import { Result, ok, err } from '../core/result';
import { endsInOpenFence, nonBodyLines } from './markdownRegions';

export interface BlockMarkers {
    start: string;
    end: string;
    /**
     * Prefixes that must NOT appear between this block's markers. Any marker of the same family
     * inside a block means nesting, which is ambiguous ownership.
     */
    nestedPrefixes?: readonly string[];
}

export interface OwnedBlock {
    /** Offset of the first character of the start marker */
    start: number;
    /** Offset just past the last character of the end marker */
    end: number;
    /** The block text, markers included */
    text: string;
}

/** The text with fenced code and frontmatter blanked out (same offsets, newlines kept). */
function visibleText(text: string): string {
    const lines = text.split('\n');
    const hidden = nonBodyLines(lines);
    return lines.map((l, i) => (hidden[i] ? l.replace(/[^\r]/g, ' ') : l)).join('\n');
}

/**
 * Find the block. `ok(null)` = there is none yet. `err('marker-conflict')` = the markers are
 * duplicated, missing one half, out of order or nested: do not write.
 */
export function findMarkedBlock(text: string, markers: BlockMarkers): Result<OwnedBlock | null> {
    const visible = visibleText(text);
    const wholeLine = (at: number, marker: string): boolean => {
        const before = at === 0 ? '\n' : visible[at - 1];
        const after = visible[at + marker.length] ?? '\n';
        return before === '\n' && (after === '\n' || after === '\r');
    };
    const locate = (marker: string): number[] => {
        const found: number[] = [];
        for (let i = visible.indexOf(marker); i !== -1; i = visible.indexOf(marker, i + marker.length)) if (wholeLine(i, marker)) found.push(i);
        return found;
    };
    const starts = locate(markers.start);
    const ends = locate(markers.end);
    if (starts.length === 0 && ends.length === 0) return ok(null);
    if (starts.length !== 1 || ends.length !== 1) return err('marker-conflict');
    if (ends[0] < starts[0]) return err('marker-conflict');
    const inner = visible.slice(starts[0] + markers.start.length, ends[0]);
    if ((markers.nestedPrefixes ?? []).some((prefix) => inner.includes(prefix))) return err('marker-conflict');
    const stop = ends[0] + markers.end.length;
    return ok({ start: starts[0], end: stop, text: text.slice(starts[0], stop) });
}

/** Replace the block, or append it. Returns the new note text. */
export function replaceMarkedBlock(text: string, block: string, markers: BlockMarkers): Result<string> {
    const found = findMarkedBlock(text, markers);
    if (!found.ok) return found;
    if (found.value === null) {
        if (endsInOpenFence(text.split('\n'))) return err('marker-conflict');
        // Only separators are added; nothing the user wrote is trimmed or rewritten.
        const sep = text === '' || /\n\r?\n$/.test(text) ? '' : text.endsWith('\n') ? '\n' : '\n\n';
        return ok(`${text}${sep}${block}\n`);
    }
    return ok(text.slice(0, found.value.start) + block + text.slice(found.value.end));
}
