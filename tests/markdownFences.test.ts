import { describe, it, expect } from 'vitest';
import { FenceTracker } from '../src/utils/markdownFences';
import { addUrlsToPendingSection } from '../src/utils/pendingSection';

/** Run lines through a tracker; returns the fenced flag per line. */
function flags(...lines: string[]): boolean[] {
    const tracker = new FenceTracker();
    return lines.map(l => tracker.next(l));
}

const URLS = ['https://x.example'];

describe('FenceTracker', () => {
    it('plain fences', () => {
        expect(flags('a', '```', 'b', '```', 'c')).toEqual([false, true, true, true, false]);
        expect(flags('~~~~', '~~~', 'x', '~~~~', 'y')).toEqual([true, true, true, true, false]);
    });

    it('a closer needs the same character and at least the opening length', () => {
        expect(flags('````', '```', 'x', '~~~~', '````', 'y')).toEqual([true, true, true, true, true, false]);
    });

    it('closing indentation counts columns: space+tab is four columns and does not close', () => {
        expect(flags('```text', ' \t```', '## h', '```', 'after')).toEqual([true, true, true, true, false]);
        expect(flags('```', '   ```', 'after')).toEqual([true, true, false]);
        expect(flags('```', '\t```', 'x', '```', 'after')).toEqual([true, true, true, true, false]);
    });

    it('an opener indented four columns (spaces or a tab) is indented code', () => {
        expect(flags('    ```', 'x')).toEqual([false, false]);
        expect(flags('\t```', 'x')).toEqual([false, false]);
        expect(flags('  \t```', 'x')).toEqual([false, false]);
    });

    it('list-item fences: container exit ends them, content stays inside', () => {
        expect(flags('- ```', '  code', '  ```', 'after')).toEqual([true, true, true, false]);
        // the outdented fence line ends the list fence and opens a new top-level one holding 'x'
        expect(flags('- ```text', '  example', '```', 'x', '```', 'after')).toEqual([true, true, true, true, true, false]);
        expect(flags('1. ```', '   code', '   ```', 'z')).toEqual([true, true, true, false]);
    });

    it('five or more spaces after a list marker make the fence indented code', () => {
        for (const spaces of [5, 6, 9]) {
            expect(flags(`-${' '.repeat(spaces)}\`\`\``, '  ## h')).toEqual([false, false]);
        }
        for (const spaces of [1, 2, 3, 4]) {
            expect(flags(`-${' '.repeat(spaces)}\`\`\``, `${' '.repeat(spaces + 1)}x`)[0]).toBe(true);
        }
        expect(flags('1.     ```', 'x')).toEqual([false, false]);
    });

    it('a backtick fence info string may not contain a backtick', () => {
        expect(flags('``` a`b', 'x')).toEqual([false, false]);
        expect(flags('~~~ a`b', 'x')).toEqual([true, true]);
    });
});

describe('addUrlsToPendingSection through the fence tracker', () => {
    it('space+tab delimiter does not close the fence, so the heading inside stays code', () => {
        const doc = '```text\n \t```\n## Pending\n```\n';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n- ${URLS[0]}\n`);
    });

    it('list marker followed by 5+ spaces is indented code: the following heading is real', () => {
        const doc = '-     ```\n  ## Pending\n  - existing\n';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`-     \`\`\`\n  ## Pending\n- ${URLS[0]}\n  - existing\n`);
    });
});
