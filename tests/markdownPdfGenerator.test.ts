/**
 * Tests for MarkdownPdfGenerator
 */

import { MarkdownPdfGenerator } from '../src/services/notebooklm/pdf/MarkdownPdfGenerator';
import { parseMarkdown } from '../src/utils/markdownParser';
import type { PdfConfig } from '../src/services/notebooklm/types';

const DEFAULT_CONFIG: PdfConfig = {
    pageSize: 'A4',
    fontName: 'helvetica',
    fontSize: 11,
    includeFrontmatter: false,
    includeTitle: true,
    marginX: 20,
    marginY: 20,
    lineHeight: 1.5,
};

const generator = new MarkdownPdfGenerator();

describe('MarkdownPdfGenerator', () => {
    describe('generate', () => {
        it('should generate a valid PDF from simple markdown', async () => {
            const markdown = `# Heading 1

This is a paragraph with some text.

## Heading 2

Another paragraph here.`;

            const pdf = await generator.generate(
                'Test Note',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should include title when includeTitle is true', async () => {
            const markdown = '# Content Heading\n\nParagraph text.';

            const pdf = await generator.generate(
                'My Note Title',
                markdown,
                { ...DEFAULT_CONFIG, includeTitle: true }
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should skip title when includeTitle is false', async () => {
            const markdown = '# Content Heading\n\nParagraph text.';

            const pdf = await generator.generate(
                'My Note Title',
                markdown,
                { ...DEFAULT_CONFIG, includeTitle: false }
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should handle lists correctly', async () => {
            const markdown = `# List Example

## Unordered List
- Item 1
- Item 2
  - Nested item 2.1
  - Nested item 2.2
- Item 3

## Ordered List
1. First item
2. Second item
3. Third item`;

            const pdf = await generator.generate(
                'Lists',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should handle code blocks by skipping them', async () => {
            const markdown = `# Code Example

Here is some code:

\`\`\`python
def hello():
    print("Hello, world!")
\`\`\`

And here is more text.`;

            const pdf = await generator.generate(
                'Code',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should handle different page sizes', async () => {
            const markdown = '# Title\n\nContent';

            for (const pageSize of ['A4', 'Letter', 'Legal'] as const) {
                const pdf = await generator.generate(
                    'Test',
                    markdown,
                    { ...DEFAULT_CONFIG, pageSize }
                );

                expect(pdf).toBeInstanceOf(ArrayBuffer);
                expect(pdf.byteLength).toBeGreaterThan(0);
            }
        });

        it('should handle different fonts', async () => {
            const markdown = '# Title\n\nContent';

            for (const fontName of ['helvetica', 'times', 'courier']) {
                const pdf = await generator.generate(
                    'Test',
                    markdown,
                    { ...DEFAULT_CONFIG, fontName }
                );

                expect(pdf).toBeInstanceOf(ArrayBuffer);
                expect(pdf.byteLength).toBeGreaterThan(0);
            }
        });

        it('should handle long content with pagination', async () => {
            const longContent = Array(100)
                .fill(null)
                .map((_, i) => `Paragraph ${i + 1}: This is a test paragraph with some content.`)
                .join('\n\n');

            const markdown = `# Long Document\n\n${longContent}`;

            const pdf = await generator.generate(
                'Long',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should include frontmatter when configured', async () => {
            const markdown = `---
title: "Test"
tags: [a, b, c]
---

# Content

This is the content.`;

            const pdf = await generator.generate(
                'Test',
                markdown,
                { ...DEFAULT_CONFIG, includeFrontmatter: true }
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should skip frontmatter when not configured', async () => {
            const markdown = `---
title: "Test"
tags: [a, b, c]
---

# Content

This is the content.`;

            const pdfWithFrontmatter = await generator.generate(
                'Test',
                markdown,
                { ...DEFAULT_CONFIG, includeFrontmatter: true }
            );

            const pdfWithoutFrontmatter = await generator.generate(
                'Test',
                markdown,
                { ...DEFAULT_CONFIG, includeFrontmatter: false }
            );

            // Both should be valid PDFs
            expect(pdfWithFrontmatter).toBeInstanceOf(ArrayBuffer);
            expect(pdfWithoutFrontmatter).toBeInstanceOf(ArrayBuffer);
            // Without frontmatter should be slightly smaller
            expect(pdfWithoutFrontmatter.byteLength).toBeLessThanOrEqual(
                pdfWithFrontmatter.byteLength
            );
        });

        it('should handle different font sizes', async () => {
            const markdown = '# Title\n\nContent';

            for (const fontSize of [9, 11, 13]) {
                const pdf = await generator.generate(
                    'Test',
                    markdown,
                    { ...DEFAULT_CONFIG, fontSize }
                );

                expect(pdf).toBeInstanceOf(ArrayBuffer);
                expect(pdf.byteLength).toBeGreaterThan(0);
            }
        });

        it('should handle empty content gracefully', async () => {
            const pdf = await generator.generate(
                'Empty',
                '',
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should return PDF as ArrayBuffer format', async () => {
            const markdown = 'Simple content';
            const pdf = await generator.generate(
                'Test',
                markdown,
                DEFAULT_CONFIG
            );

            // Verify it starts with PDF magic number
            const view = new Uint8Array(pdf);
            const header = String.fromCharCode(...Array.from(view.slice(0, 4)));
            expect(header).toBe('%PDF');
        });

        it('should handle markdown tables', async () => {
            const markdown = `# Meeting Minutes

## Decisions

| ID | Decision | Owner | Due |
|----|----------|-------|-----|
| D1 | Approve budget | Alice | 2026-02-01 |
| D2 | Hire contractor | Bob | 2026-03-01 |

## Actions

| ID | Action | Owner | Due | Status |
|----|--------|-------|-----|--------|
| A1 | Draft proposal | Alice | 2026-02-15 | new |
| A2 | Review code | Bob | 2026-02-10 | new |

## Notes

Some follow-up text here.`;

            const pdf = await generator.generate(
                'Minutes',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            // A PDF with tables should be noticeably larger than an empty one
            const emptyPdf = await generator.generate('Empty', '', DEFAULT_CONFIG);
            expect(pdf.byteLength).toBeGreaterThan(emptyPdf.byteLength * 1.2);
        });

        it('should handle tables parsed correctly', () => {
            const markdown = `## Decisions

| ID | Decision | Owner |
|----|----------|-------|
| D1 | Budget | Alice |
| D2 | Hire | Bob |`;

            const lines = parseMarkdown(markdown, false);
            const tableRows = lines.filter(l => l.type === 'table_row');
            const tableSeps = lines.filter(l => l.type === 'table_separator');

            // Should detect 3 table_row lines (1 header + 2 data)
            expect(tableRows.length).toBe(3);
            expect(tableSeps.length).toBe(1);

            // Verify cells are parsed
            expect(tableRows[0].cells).toEqual(['ID', 'Decision', 'Owner']);
            expect(tableRows[1].cells).toEqual(['D1', 'Budget', 'Alice']);
        });

        it('should handle three-level heading hierarchy', async () => {
            const markdown = `# H1 Title

Content here.

## H2 Subtitle

More content.

### H3 Sub-subtitle

Even more content.`;

            const pdf = await generator.generate(
                'Headings',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });
    });

    describe('callout/blockquote handling', () => {
        it('should detect tables inside callout-wrapped content', () => {
            const markdown = `> [!info] External / Client Safe Minutes
> ## Decisions
>
> | ID | Decision | Owner |
> |----|----------|-------|
> | D1 | Budget | Alice |`;

            const lines = parseMarkdown(markdown, false);
            const tableRows = lines.filter(l => l.type === 'table_row');
            const headings = lines.filter(l => l.type === 'heading2');

            // After preprocessMarkdown strips blockquote prefixes,
            // tables and headings should be detected
            expect(tableRows.length).toBe(2); // header + 1 data row
            expect(headings.length).toBe(1);
            expect(headings[0].content).toBe('Decisions');
        });

        it('should handle plain (non-callout) content unchanged', () => {
            const markdown = `## Decisions

| ID | Decision |
|----|----------|
| D1 | Budget |`;

            const lines = parseMarkdown(markdown, false);
            const tableRows = lines.filter(l => l.type === 'table_row');

            expect(tableRows.length).toBe(2);
        });
    });

    describe('markdown sanitization', () => {
        it('should sanitize internal links', async () => {
            const markdown = `# Title

This is a [[internal link]] and [[link|display text]].`;

            const pdf = await generator.generate(
                'Links',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should sanitize external links', async () => {
            const markdown = `# Title

Check out [this link](https://example.com) for more info.`;

            const pdf = await generator.generate(
                'Links',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should sanitize bold and italic text', async () => {
            const markdown = `# Title

This is **bold text**, __also bold__, *italic text*, and _also italic_.`;

            const pdf = await generator.generate(
                'Formatting',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should sanitize strikethrough', async () => {
            const markdown = `# Title

This is ~~strikethrough~~ text.`;

            const pdf = await generator.generate(
                'Formatting',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should sanitize inline code', async () => {
            const markdown = `# Title

Use \`const x = 5\` for variable declaration.`;

            const pdf = await generator.generate(
                'Code',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should skip complex blocks gracefully', async () => {
            const markdown = `# Title

Regular paragraph.

\`\`\`dataview
TABLE
FROM "Folder"
WHERE status = "Active"
\`\`\`

Another paragraph.

\`\`\`query
SELECT * FROM table
\`\`\`

Final paragraph.`;

            const pdf = await generator.generate(
                'Complex',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should skip HTML blocks', async () => {
            const markdown = `# Title

Regular paragraph.

<div class="custom">
  <p>HTML content</p>
</div>

Another paragraph.`;

            const pdf = await generator.generate(
                'HTML',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should skip comment blocks', async () => {
            const markdown = `# Title

Regular paragraph.

%% This is a comment %%

Another paragraph.`;

            const pdf = await generator.generate(
                'Comments',
                markdown,
                DEFAULT_CONFIG
            );

            expect(pdf).toBeInstanceOf(ArrayBuffer);
            expect(pdf.byteLength).toBeGreaterThan(0);
        });

        it('should strip inline and multi-line comments from parsed output', () => {
            const markdown = `Visible line.
%% Hidden inline %%
%% Multi
line
comment %%
Still visible.`;

            const lines = parseMarkdown(markdown, false);
            const content = lines.map(line => line.content).join(' ');

            expect(content).toContain('Visible line.');
            expect(content).toContain('Still visible.');
            expect(content).not.toContain('Hidden inline');
            expect(content).not.toContain('Multi');
            expect(content).not.toContain('comment');
        });

        it('should strip image embeds from parsed output', () => {
            const markdown = 'Start ![[image.png]] middle ![alt](https://example.com/image.jpg) end';

            const lines = parseMarkdown(markdown, false);
            const content = lines.map(line => line.content).join(' ');

            expect(content).toContain('Start');
            expect(content).toContain('middle');
            expect(content).toContain('end');
            expect(content).not.toContain('image.png');
            expect(content).not.toContain('https://');
        });

        it('should preserve ordered list numbering in parsed output', () => {
            const markdown = `1. First item
2. Second item`;

            const lines = parseMarkdown(markdown, false);
            const ordered = lines.filter(line => line.type === 'ordered');

            expect(ordered.length).toBe(2);
            expect(ordered[0].content.startsWith('1.')).toBe(true);
            expect(ordered[1].content.startsWith('2.')).toBe(true);
        });
    });

    describe('pure function guarantee', () => {
        it('should not modify input parameters', async () => {
            const config: PdfConfig = { ...DEFAULT_CONFIG };
            const originalConfig = JSON.stringify(config);

            const markdown = '# Test\n\nContent';

            await generator.generate('Test', markdown, config);

            expect(JSON.stringify(config)).toBe(originalConfig);
        });

        it('should produce consistent output for same input', async () => {
            const markdown = '# Title\n\nSame content.';

            const pdf1 = await generator.generate(
                'Test',
                markdown,
                DEFAULT_CONFIG
            );

            const pdf2 = await generator.generate(
                'Test',
                markdown,
                DEFAULT_CONFIG
            );

            // Both should be valid PDFs of similar size
            // (exact byte-for-byte match may vary due to timestamps/internal IDs)
            expect(pdf1.byteLength).toBeGreaterThan(0);
            expect(pdf2.byteLength).toBeGreaterThan(0);
            // Within 1% tolerance for metadata differences
            expect(Math.abs(pdf1.byteLength - pdf2.byteLength)).toBeLessThan(
                Math.max(pdf1.byteLength, pdf2.byteLength) * 0.01
            );
        });
    });
});
