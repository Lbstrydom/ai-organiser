import { describe, expect, it } from 'vitest';
import {
    splitIntoBlocks,
    extractHighlightedPassages,
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

    it('extractHighlightedPassages ignores code fences', () => {
        const content = `Before ==keep==
\`\`\`
code ==skip==
\`\`\`
<mark>also keep</mark>`;

        const passages = extractHighlightedPassages(content);
        const texts = passages.map(p => p.text);

        expect(texts).toContain('keep');
        expect(texts).toContain('also keep');
        expect(texts).not.toContain('skip');
    });

    it('stripHighlightMarkup removes highlight markers', () => {
        const input = 'This is <mark class="hl">important</mark> and ==clear==.';
        expect(stripHighlightMarkup(input)).toBe('This is important and clear.');
    });
});
