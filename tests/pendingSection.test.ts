import { describe, it, expect } from 'vitest';
import { addUrlsToPendingSection } from '../src/utils/pendingSection';

const URLS = ['https://a.example', 'https://b.example'];
const LIST = '- https://a.example\n- https://b.example';

describe('addUrlsToPendingSection', () => {
    it('inserts directly under an existing heading, before its items', () => {
        const doc = '# T\n\n## Pending\n- https://old.example\n\n## Other\nx';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(
            `# T\n\n## Pending\n${LIST}\n- https://old.example\n\n## Other\nx`,
        );
    });

    it('handles the heading as the last line with no trailing newline', () => {
        expect(addUrlsToPendingSection('# T\n\n## Pending', URLS)).toBe(`# T\n\n## Pending\n${LIST}\n`);
    });

    it('handles CRLF documents', () => {
        const out = addUrlsToPendingSection('# T\r\n\r\n## Pending\r\n- old\r\n', URLS);
        expect(out).toBe(`# T\r\n\r\n## Pending\r\n${LIST.replace(/\n/g, '\r\n')}\r\n- old\r\n`);
    });

    it('does not treat "## Pending Integration" as the heading (appends a new section)', () => {
        const doc = '# T\n\n## Pending Integration\nkeep\n';
        const out = addUrlsToPendingSection(doc, URLS);
        expect(out).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
        expect(out.startsWith(doc)).toBe(true);
    });

    it('ignores other levels and longer titles', () => {
        for (const heading of ['### Pending', '# Pending', '## Pending items', '## Pending#', '## Pending x']) {
            const doc = `a\n${heading}\nb`;
            expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
        }
    });

    it('accepts a closing hash run separated by whitespace, and any case', () => {
        expect(addUrlsToPendingSection('## Pending ##\nz', URLS)).toBe(`## Pending ##\n${LIST}\nz`);
        expect(addUrlsToPendingSection('## pending\nz', URLS)).toBe(`## pending\n${LIST}\nz`);
    });

    it('ignores a heading inside a fenced code block and finds the real one after it', () => {
        const doc = '```md\n## Pending\n```\n\n## Pending\nreal';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`\`\`\`md\n## Pending\n\`\`\`\n\n## Pending\n${LIST}\nreal`);
    });

    it('only a fenced heading: appends a new section and leaves the fence alone', () => {
        const doc = '```\n## Pending\n```\n';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('tracks fence length and marker: a 3-backtick line inside a 4-backtick fence does not close it', () => {
        const doc = '````\n```\n## Pending\n````\ntail';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('fences opened inside list items hide a heading-looking line in them', () => {
        for (const opener of ['- ```', '1. ```', '* ~~~', '  - ```']) {
            const fence = opener.includes('~') ? '~~~' : '```';
            const pad = ' '.repeat(opener.search(/[`~]/));
            const doc = `a\n${opener}\n${pad}## Pending\n${pad}${fence}\ntail`;
            expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
        }
    });

    it('a list-item fence ends with its list item: an outdented fence line is a new top-level fence', () => {
        const doc = '- ```text\n  example\n```\n## Pending\n```\n';
        // the unindented line closes the list container and opens a new fence that holds the heading
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('a delimiter indented 4+ spaces does not close a top-level fence', () => {
        const doc = '```\n    ```\n## Pending\n```\n';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('a line indented 4+ spaces is indented code, not a fence opener', () => {
        const doc = '    ```\n\n## Pending\nz';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`    \`\`\`\n\n## Pending\n${LIST}\nz`);
    });

    it('tilde fences', () => {
        const doc = '~~~\n## Pending\n~~~\ntail';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('unclosed terminal fence: the new section goes before the fence, not inside it', () => {
        const doc = 'intro\n\n```js\nconst x = 1;\n## Pending\n';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`intro\n\n## Pending\n${LIST}\n\n\`\`\`js\nconst x = 1;\n## Pending\n`);
    });

    it('ignores a heading-looking line inside leading frontmatter', () => {
        const doc = '---\nnote: |\n  ## Pending\n---\nbody';
        const out = addUrlsToPendingSection(doc, URLS);
        expect(out).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('a BOM before the opening frontmatter fence does not expose a heading-like line inside it', () => {
        const doc = String.fromCharCode(0xFEFF) + '---\nnote: |\n  ## Pending\n---\nbody';
        expect(addUrlsToPendingSection(doc, URLS)).toBe(`${doc}\n\n## Pending\n${LIST}\n`);
    });

    it('no heading: byte-identical to the previous append', () => {
        expect(addUrlsToPendingSection('body', URLS)).toBe('body\n\n## Pending\n' + LIST + '\n');
    });

    it('empty url list is a no-op', () => {
        expect(addUrlsToPendingSection('x\n## Pending\ny', [])).toBe('x\n## Pending\ny');
    });
});
