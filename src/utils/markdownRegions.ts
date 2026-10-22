/**
 * Markdown region helpers shared by the attachment helper and the agent index.
 */

/**
 * Mark the lines that are not Markdown body: leading YAML frontmatter and fenced code. A fence is
 * closed only by a fence of the same character that is at least as long as the opening one and has
 * no text after it (CommonMark), so a `~~~` line inside a backtick fence does not end it.
 */
export function nonBodyLines(lines: readonly string[]): boolean[] {
    return scanRegions(lines).mask;
}

/** True when the text ends inside a fenced block that was never closed. */
export function endsInOpenFence(lines: readonly string[]): boolean {
    return scanRegions(lines).openFence;
}

// A fence may sit inside a block quote or a list item, so up to a few indent levels, `>` markers and one list marker
// may precede it.
const FENCE_LINE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;

function scanRegions(lines: readonly string[]): { mask: boolean[]; openFence: boolean } {
    const out = new Array<boolean>(lines.length).fill(false);
    let i = 0;
    if (lines.length > 0 && lines[0].trim() === '---') {
        for (let j = 1; j < lines.length; j++) {
            if (lines[j].trim() === '---' || lines[j].trim() === '...') {
                for (let k = 0; k <= j; k++) out[k] = true;
                i = j + 1;
                break;
            }
        }
    }
    let fence: { ch: string; len: number } | null = null;
    for (; i < lines.length; i++) {
        const m = lines[i].match(FENCE_LINE);
        if (!fence) {
            // A backtick fence cannot have a backtick in its info string (that is inline code).
            if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
                fence = { ch: m[1][0], len: m[1].length };
                out[i] = true;
            }
            continue;
        }
        out[i] = true;
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
    }
    return { mask: out, openFence: fence !== null };
}
