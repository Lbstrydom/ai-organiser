import {
    splitIntoBlocks,
    stripHighlightMarkup
} from '../src/utils/highlightExtractor';

describe('highlightExtractor', () => {
    it('splitIntoBlocks respects structural blocks', () => {
        const content = `---
title: Test
---
# Heading
Paragraph line one ==highlighted==
line two

\`\`\`ts
const code = "==no highlight==";
\`\`\`

> [!note]
> Callout line
> Another line

- item one
- item two

| A | B |
| - | - |
| 1 | 2 |

![[image.png]]

![[note.md]]
`;

        const blocks = splitIntoBlocks(content);
        const types = blocks.map(block => block.type);

        expect(types).toEqual([
            'heading',
            'paragraph',
            'code',
            'callout',
            'list',
            'table',
            'paragraph',
            'paragraph'
        ]);

        expect(blocks[1].hasHighlight).toBe(true);
        expect(blocks[2].hasHighlight).toBe(false);
        expect(blocks[5].displayText).toBe('[Table: 3 rows]');
        expect(blocks[6].displayText).toBe('[Image: image.png]');
        expect(blocks[7].displayText).toBe('[Embed: note.md]');
    });

    it('list continuation lines stay in the same list block', () => {
        const content = `- item one
  continuation of item one
- item two
  - nested item
  more nested content`;

        const blocks = splitIntoBlocks(content);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('list');
        expect(blocks[0].text).toContain('continuation of item one');
        expect(blocks[0].text).toContain('nested item');
        expect(blocks[0].text).toContain('more nested content');
    });

    it('list block ends at non-indented non-list content', () => {
        const content = `- item one
  continuation
Not a list line`;

        const blocks = splitIntoBlocks(content);

        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe('list');
        expect(blocks[0].text).toContain('continuation');
        expect(blocks[1].type).toBe('paragraph');
        expect(blocks[1].text).toBe('Not a list line');
    });

    it('code blocks containing == are not detected as highlights', () => {
        const content = `\`\`\`python
if x == 5:
    print(<mark>hello</mark>)
\`\`\``;

        const blocks = splitIntoBlocks(content);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('code');
        expect(blocks[0].hasHighlight).toBe(false);
    });

    it('stripHighlightMarkup removes highlight markers', () => {
        const input = 'This is <mark class="hl">important</mark> and ==clear==.';
        expect(stripHighlightMarkup(input)).toBe('This is important and clear.');
    });
});
