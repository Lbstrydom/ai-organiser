/**
 * Mermaid Diagram Line-Level Diff
 * LCS (Longest Common Subsequence) based diff for comparing Mermaid code versions.
 * Suitable for small-to-medium diagrams (10–100 lines).
 */

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
    type: DiffLineType;
    content: string;
}

export interface DiffStats {
    added: number;
    removed: number;
    unchanged: number;
}

/**
 * Compute a line-level diff between two Mermaid code strings.
 * Returns a sequence of DiffLine objects describing additions, removals, and
 * unchanged lines in the order they appear in the new version.
 */
export function computeLineDiff(oldCode: string, newCode: string): DiffLine[] {
    const a = oldCode === '' ? [] : oldCode.split('\n');
    const b = newCode === '' ? [] : newCode.split('\n');
    const m = a.length;
    const n = b.length;

    // Build LCS table — O(m*n), acceptable for typical Mermaid diagrams
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
        dp[i] = new Array(n + 1).fill(0);
    }
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Trace back iteratively (avoids call-stack overflow for large inputs)
    const result: DiffLine[] = [];
    let i = m;
    let j = n;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            result.unshift({ type: 'unchanged', content: a[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'added', content: b[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'removed', content: a[i - 1] });
            i--;
        }
    }

    return result;
}

/**
 * Count added / removed / unchanged lines in a diff result.
 */
export function getDiffStats(diff: DiffLine[]): DiffStats {
    return diff.reduce(
        (acc, line) => {
            acc[line.type]++;
            return acc;
        },
        { added: 0, removed: 0, unchanged: 0 },
    );
}

/**
 * Returns true if the diff contains any actual changes (i.e. not all unchanged).
 */
export function hasMeaningfulChanges(diff: DiffLine[]): boolean {
    return diff.some(l => l.type !== 'unchanged');
}
