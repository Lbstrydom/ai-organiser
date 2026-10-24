/**
 * Research "save to pending": add source URLs under the note's `## Pending` heading.
 *
 * One scanner both detects the heading and decides where the text goes, so detection
 * and insertion can never disagree. A heading is a level-2 ATX line (closing hashes
 * need preceding whitespace) outside fenced code and outside leading frontmatter.
 */

const PENDING_HEADING = /^ {0,3}##[ \t]+Pending(?:[ \t]+#+)?[ \t]*$/i;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Scan {
    /** Offset just past the first real Pending heading line (incl. its line break), or -1. */
    afterHeading: number;
    /** True when that heading line is the last line and has no line break. */
    headingAtEof: boolean;
    /** Start offset of the opening line of a fence left unclosed at EOF, or -1. */
    unclosedFenceStart: number;
}

function scan(doc: string): Scan {
    const result: Scan = { afterHeading: -1, headingAtEof: false, unclosedFenceStart: -1 };
    let offset = 0;
    let lineNo = 0;
    let fence: { char: string; len: number; start: number } | null = null;
    let inFrontmatter = false;

    while (offset <= doc.length) {
        const nl = doc.indexOf('\n', offset);
        const end = nl === -1 ? doc.length : nl;
        let line = doc.slice(offset, end).replace(/\r$/, '');
        // A byte-order mark in front of the opening fence must not hide the frontmatter.
        if (lineNo === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
        const next = nl === -1 ? doc.length : nl + 1;

        if (lineNo === 0 && line.trimEnd() === '---') {
            inFrontmatter = doc.slice(next).split(/\r?\n/).some(l => /^(---|\.\.\.)\s*$/.test(l));
        } else if (inFrontmatter) {
            if (/^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
        } else if (fence) {
            const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
            if (close.test(line)) fence = null;
        } else {
            const open = FENCE_OPEN.exec(line);
            // A backtick fence's info string may not contain a backtick (CommonMark).
            if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
                fence = { char: open[1][0], len: open[1].length, start: offset };
            } else if (result.afterHeading === -1 && PENDING_HEADING.test(line)) {
                result.afterHeading = next;
                result.headingAtEof = nl === -1;
            }
        }

        if (nl === -1) break;
        offset = next;
        lineNo++;
    }

    if (fence) result.unclosedFenceStart = fence.start;
    return result;
}

/**
 * Return `doc` with `urls` listed under the first `## Pending` heading (before its
 * existing items), or under a new `## Pending` section when there is none. A new
 * section is never created inside an unclosed code fence. Empty `urls` is a no-op.
 */
export function addUrlsToPendingSection(doc: string, urls: string[]): string {
    if (urls.length === 0) return doc;
    const eol = doc.includes('\r\n') ? '\r\n' : '\n';
    const list = urls.map(u => `- ${u}`).join(eol);
    const found = scan(doc);

    if (found.afterHeading !== -1) {
        if (found.headingAtEof) return `${doc}${eol}${list}${eol}`;
        return doc.slice(0, found.afterHeading) + list + eol + doc.slice(found.afterHeading);
    }

    if (found.unclosedFenceStart !== -1) {
        const before = doc.slice(0, found.unclosedFenceStart);
        const lead = before === '' || before.endsWith(eol + eol) ? '' : before.endsWith('\n') ? eol : eol + eol;
        return `${before}${lead}## Pending${eol}${list}${eol}${eol}${doc.slice(found.unclosedFenceStart)}`;
    }

    return `${doc}${eol}${eol}## Pending${eol}${list}${eol}`;
}
