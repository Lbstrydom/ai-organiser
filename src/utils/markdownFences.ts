/**
 * Line-by-line tracking of fenced code blocks, so a scanner that looks for headings can
 * ignore anything that is code. Shared by the pending-section and Kindle notes scanners.
 *
 * Follows CommonMark for the cases notes actually contain: a fence opens with 3+ backticks
 * or tildes at 0-3 spaces of indentation, or right after a list marker ("- ```", "1. ```");
 * it closes on the same character with at least the opening length at 0-3 spaces of
 * indentation relative to its container; a list-contained fence also ends when a later
 * non-blank line is indented less than the list item's content (the container closed).
 * Not handled: fences inside block quotes, or on a list continuation line indented 4+.
 */

interface OpenFence {
    char: string;
    len: number;
    /** Columns of indentation the container's content needs (0 at top level). */
    container: number;
}

const OPENER = /^( *)(?:((?:[-*+]|\d{1,9}[.)])( +))?)(`{3,}|~{3,})(.*)$/;

export class FenceTracker {
    private fence: OpenFence | null = null;

    /** Feed the next line. True when it is a fence delimiter or inside a fenced block. */
    next(rawLine: string): boolean {
        this.justOpened = false;
        const line = rawLine.replace(/\r$/, '').replace(/^\t+/, tabs => ' '.repeat(4 * tabs.length));
        const indent = line.length - line.trimStart().length;

        if (this.fence) {
            const outsideContainer = line.trim() !== '' && indent < this.fence.container;
            if (!outsideContainer) {
                const relative = indent - this.fence.container;
                const closer = new RegExp(`^${this.fence.char}{${this.fence.len},}[ \\t]*$`);
                if (relative <= 3 && closer.test(line.trimStart())) this.fence = null;
                return true;
            }
            // The list item ended, taking its fence with it: this line starts fresh.
            this.fence = null;
        }

        const open = OPENER.exec(line);
        if (!open) return false;
        const [, lead, marker, gap, ticks, info] = open;
        if (lead.length > 3) return false;
        // A backtick fence's info string may not contain a backtick.
        if (ticks[0] === '`' && info.includes('`')) return false;
        const container = marker ? lead.length + marker.length - gap.length + (gap.length >= 5 ? 1 : gap.length) : 0;
        this.fence = { char: ticks[0], len: ticks.length, container };
        this.justOpened = true;
        return true;
    }

    /** True when the last line fed opened a fence (so a caller can remember where it began). */
    justOpened = false;

    /** True while the last line fed left a fence open (it runs to the end of the document). */
    get isOpen(): boolean {
        return this.fence !== null;
    }
}
