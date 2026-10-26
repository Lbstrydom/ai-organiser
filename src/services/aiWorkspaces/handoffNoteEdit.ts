/**
 * Adding hand-back lines to a project note. Pure text transforms, applied through a reviewed edit by the caller.
 *
 * A line is added under its heading (the heading is created once, at the end, when absent) and carries
 * `<!-- aio:handoff id=<itemId> -->`: a line with the marker already present is never added again, which is what makes a
 * replayed or retried apply idempotent. Headings inside fenced code or frontmatter are not headings.
 */
import { Result, ok, err } from '../../core/result';
import { endsInOpenFence, nonBodyLines } from '../../utils/markdownRegions';

const marker = (id: string): string => `<!-- aio:handoff id=${id} -->`;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

export interface LineToAdd {
    id: string;
    text: string;
}

/** Items with their marker already present in the note. */
export function appliedIds(noteText: string, ids: readonly string[]): Set<string> {
    return new Set(ids.filter((id) => noteText.includes(marker(id))));
}

/** One line of a note's list: single line, no embedded markers, so it cannot break out of the list or forge a marker. */
function listLine(text: string, id: string): string {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s*\n\s*/g, ' ').trim();
    return `- ${clean} ${marker(id)}`;
}

/**
 * Add the lines under `## <heading>`. Returns the new text, or the same text when every line is already there.
 * A note it cannot place a new heading in (an open code fence at the end) is `handoff-note-unplaceable`.
 */
export function addUnderHeading(noteText: string, heading: string, lines: readonly LineToAdd[]): Result<string> {
    const fresh = lines.filter((l) => !noteText.includes(marker(l.id)));
    if (fresh.length === 0) return ok(noteText);
    const rendered = fresh.map((l) => listLine(l.text, l.id));
    const all = noteText.split('\n');
    // Text added to a note that ends inside an open code fence would land inside the fence.
    if (endsInOpenFence(all)) return err('handoff-note-unplaceable');
    const hidden = nonBodyLines(all);
    let at = -1;
    let level = 0;
    for (let i = 0; i < all.length; i++) {
        if (hidden[i]) continue;
        const m = HEADING.exec(all[i]);
        if (m && m[2].trim().toLowerCase() === heading.toLowerCase()) { at = i; level = m[1].length; break; }
    }
    if (at === -1) {
        const sep = noteText === '' || /\n\n$/.test(noteText) ? '' : noteText.endsWith('\n') ? '\n' : '\n\n';
        return ok(`${noteText}${sep}## ${heading}\n\n${rendered.join('\n')}\n`);
    }
    // The end of the section: before the next heading of the same or a higher level, trailing blank lines kept after the list.
    let end = all.length;
    for (let i = at + 1; i < all.length; i++) {
        if (hidden[i]) continue;
        const m = HEADING.exec(all[i]);
        if (m && m[1].length <= level) { end = i; break; }
    }
    let insertAt = end;
    while (insertAt > at + 1 && all[insertAt - 1].trim() === '') insertAt--;
    const before = all.slice(0, insertAt);
    const after = all.slice(insertAt);
    // A section that is just its heading gets a blank line first.
    const spacer = insertAt === at + 1 ? [''] : [];
    return ok([...before, ...spacer, ...rendered, ...after].join('\n'));
}
