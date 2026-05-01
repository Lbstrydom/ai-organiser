/**
 * Markdown-to-prose transformer tests — golden-style covering the supported-syntax matrix.
 * Includes G2 verification: AIO-NARRATION managed block is stripped before any other rule.
 */

import { describe, it, expect } from 'vitest';
import { transformToSpokenProse } from '../src/services/audioNarration/markdownToProseTransformer';
import { DEFAULT_PROSE_OPTIONS } from '../src/services/audioNarration/narrationTypes';

function transform(md: string) {
    return transformToSpokenProse(md);
}

describe('markdown-to-prose: defaults', () => {
    it('default options are exported and stable', () => {
        expect(DEFAULT_PROSE_OPTIONS).toEqual({
            codeBlockMode: 'placeholder',
            tableMode: 'row-prose',
            imageMode: 'alt-text',
        });
    });

    it('returns empty for empty input', () => {
        const r = transform('');
        expect(r.spokenText).toBe('');
        expect(r.stats.charCount).toBe(0);
        expect(r.stats.wordCount).toBe(0);
    });

    it('returns empty for whitespace-only input', () => {
        const r = transform('   \n\n  \t  \n');
        expect(r.spokenText).toBe('');
    });

    it('strips frontmatter completely', () => {
        const md = '---\ntitle: Test\ntags: [a, b]\n---\n\nHello world.';
        const r = transform(md);
        expect(r.spokenText).toContain('Hello world');
        expect(r.spokenText).not.toContain('title:');
        expect(r.spokenText).not.toContain('---');
    });

    it('handles frontmatter-only note (returns empty post-strip)', () => {
        const md = '---\ntitle: Empty\n---\n';
        const r = transform(md);
        expect(r.spokenText).toBe('');
    });
});

describe('markdown-to-prose: G2 — strips AIO-NARRATION block before other rules', () => {
    it('removes managed block at top of note', () => {
        const md = `<!-- AIO-NARRATION:START -->
🎧 ![[Narrations/foo.mp3]]
<!-- AIO-NARRATION:END -->

# My note

Body content.`;
        const r = transform(md);
        expect(r.spokenText).not.toContain('embedded image');
        expect(r.spokenText).not.toContain('foo.mp3');
        expect(r.spokenText).toContain('Note title: My note');
        expect(r.spokenText).toContain('Body content');
    });

    it('removes block when surrounded by user content', () => {
        const md = `# Header

<!-- AIO-NARRATION:START -->
🎧 ![[old.mp3]]
<!-- AIO-NARRATION:END -->

Body.`;
        const r = transform(md);
        expect(r.spokenText).not.toContain('old.mp3');
        expect(r.spokenText).not.toContain('embedded image');
        expect(r.spokenText).toContain('Header');
        expect(r.spokenText).toContain('Body');
    });

    it('idempotent: re-narrating produces identical output regardless of prior block', () => {
        const baseMd = '# Hello\n\nWorld.';
        const withBlock = `<!-- AIO-NARRATION:START -->
🎧 ![[a.mp3]]
<!-- AIO-NARRATION:END -->

${baseMd}`;
        const a = transform(baseMd).spokenText;
        const b = transform(withBlock).spokenText;
        expect(a).toBe(b);
    });
});

describe('markdown-to-prose: headings', () => {
    it('H1 → "Note title: X."', () => {
        expect(transform('# My title').spokenText).toBe('Note title: My title.');
    });

    it('H2 → "Section: X."', () => {
        expect(transform('## My section').spokenText).toBe('Section: My section.');
    });

    it('H3-H6 → "X."', () => {
        expect(transform('### Subsection').spokenText).toBe('Subsection.');
        expect(transform('#### Deeper').spokenText).toBe('Deeper.');
    });

    it('strips trailing # markers', () => {
        expect(transform('## Section ##').spokenText).toBe('Section: Section.');
    });

    it('counts sectionCount across H1-H6', () => {
        const r = transform('# A\n\n## B\n\n### C');
        expect(r.stats.sectionCount).toBe(3);
    });
});

describe('markdown-to-prose: inline formatting', () => {
    it('strips bold/italic/strikethrough', () => {
        const r = transform('This is **bold** and *italic* and ~~strike~~.');
        expect(r.spokenText).toBe('This is bold and italic and strike.');
    });

    it('strips inline code backticks', () => {
        expect(transform('Use `console.log` for logging.').spokenText).toBe('Use console.log for logging.');
    });

    it('replaces inline math with placeholder', () => {
        expect(transform('We have $E = mc^2$ here.').spokenText).toBe('We have [math] here.');
    });

    it('strips html inline tags but keeps text', () => {
        expect(transform('Use H<sub>2</sub>O').spokenText).toBe('Use H2O');
    });

    it('strips emoji', () => {
        // Whitespace-collapse follow-up means dropped emoji leaves a single space
        expect(transform('Hello 🎉 world.').spokenText).toBe('Hello world.');
    });
});

describe('markdown-to-prose: links', () => {
    it('markdown link reads text only', () => {
        expect(transform('Visit [our site](https://example.com) today.').spokenText)
            .toBe('Visit our site today.');
    });

    it('image markdown with alt → "[image: alt]"', () => {
        expect(transform('![cat photo](cat.png)').spokenText).toBe('[image: cat photo]');
    });

    it('image markdown without alt is dropped', () => {
        expect(transform('![](anon.png)').spokenText).toBe('');
    });

    it('imageMode=omit drops images entirely', () => {
        const r = transformToSpokenProse('![cat](cat.png)', { imageMode: 'omit' });
        expect(r.spokenText).toBe('');
    });
});

describe('markdown-to-prose: wikilinks', () => {
    it('plain wikilink reads note name', () => {
        expect(transform('See [[Other Note]] for details.').spokenText).toBe('See Other Note for details.');
    });

    it('wikilink with display reads display only', () => {
        expect(transform('See [[Other Note|the other one]] for details.').spokenText)
            .toBe('See the other one for details.');
    });

    it('wikilink with subpath drops subpath', () => {
        expect(transform('See [[Note#section]] here.').spokenText).toBe('See Note here.');
    });

    it('wikilink with subpath + display reads display', () => {
        expect(transform('See [[Note#section|the bit]] here.').spokenText).toBe('See the bit here.');
    });

    it('image embed ![[image.png]] → placeholder', () => {
        expect(transform('![[diagram.png]]').spokenText).toBe('[embedded image]');
    });

    it('block embed ![[Note^block]] → placeholder', () => {
        expect(transform('![[Other^block]]').spokenText).toBe('[embedded block]');
    });

    it('note transclusion ![[Note]] → placeholder', () => {
        expect(transform('![[Other Note]]').spokenText).toBe('[embedded note: Other Note]');
    });
});

describe('markdown-to-prose: code blocks', () => {
    it('default mode = placeholder', () => {
        const md = '```js\nconst x = 1;\n```';
        expect(transform(md).spokenText).toBe('[code block omitted]');
    });

    it('mermaid → "[diagram omitted]"', () => {
        const md = '```mermaid\ngraph TD\nA --> B\n```';
        expect(transform(md).spokenText).toBe('[diagram omitted]');
    });

    it('omit mode drops silently', () => {
        const md = '```\nfoo\n```\nAfter.';
        const r = transformToSpokenProse(md, { codeBlockMode: 'omit' });
        expect(r.spokenText).toBe('After.');
    });

    it('read-inline mode reads contents', () => {
        const md = '```\nline one\nline two\n```';
        const r = transformToSpokenProse(md, { codeBlockMode: 'read-inline' });
        expect(r.spokenText).toContain('Code block');
        expect(r.spokenText).toContain('line one');
    });
});

describe('markdown-to-prose: lists', () => {
    it('flattens unordered list', () => {
        const md = '- First\n- Second\n- Third';
        expect(transform(md).spokenText).toBe('First. Second. Third.');
    });

    it('flattens ordered list (number prefix dropped)', () => {
        const md = '1. First\n2. Second\n3. Third';
        expect(transform(md).spokenText).toBe('First. Second. Third.');
    });

    it('task list uses Done/Todo prefix', () => {
        const md = '- [x] Buy milk\n- [ ] Walk dog';
        expect(transform(md).spokenText).toBe('Done: Buy milk. Todo: Walk dog.');
    });
});

describe('markdown-to-prose: tables', () => {
    it('row-prose mode uses ordinals + header pattern', () => {
        const md = `| Stop | Time |\n|------|------|\n| Aphrodite | 45 min |\n| Petra | 30 min |`;
        const r = transform(md);
        expect(r.spokenText).toContain('First');
        expect(r.spokenText).toContain('Stop: Aphrodite');
        expect(r.spokenText).toContain('Time: 45 min');
        expect(r.spokenText).toContain('Second');
    });

    it('skips alignment row', () => {
        const md = `| A | B |\n|:---|---:|\n| 1 | 2 |`;
        const r = transform(md);
        expect(r.spokenText).not.toContain('---');
    });

    it('header-summary mode produces concise sentence', () => {
        const md = `| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |`;
        const r = transformToSpokenProse(md, { tableMode: 'header-summary' });
        expect(r.spokenText).toContain('Table with 2 rows');
        expect(r.spokenText).toContain('A, B');
    });

    it('omit mode drops table', () => {
        const md = `Before.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter.`;
        const r = transformToSpokenProse(md, { tableMode: 'omit' });
        expect(r.spokenText).toContain('Before');
        expect(r.spokenText).toContain('After');
        expect(r.spokenText).not.toContain('A: 1');
    });
});

describe('markdown-to-prose: blockquotes and callouts', () => {
    it('plain blockquote → "Quote: ... End quote."', () => {
        expect(transform('> This is wisdom.').spokenText).toBe('Quote: This is wisdom. End quote.');
    });

    it('callout → "Type: title."', () => {
        expect(transform('> [!note] Important').spokenText).toBe('Note: Important.');
    });

    it('callout without title → "Type."', () => {
        expect(transform('> [!warning]').spokenText).toBe('Warning.');
    });
});

describe('markdown-to-prose: HRs, footnotes, comments', () => {
    it('horizontal rule introduces sentence break', () => {
        const r = transform('Before.\n\n---\n\nAfter.');
        expect(r.spokenText).toContain('Before');
        expect(r.spokenText).toContain('After');
    });

    it('Obsidian comments %% ... %% are dropped', () => {
        expect(transform('Hello %%private note%% world.').spokenText).toBe('Hello world.');
    });

    it('footnote reference is dropped from body', () => {
        expect(transform('Citation needed[^1].').spokenText).toBe('Citation needed.');
    });

    it('footnote definition is read at end as "Footnote: ..."', () => {
        const md = 'Body[^1].\n\n[^1]: The detail';
        const r = transform(md);
        expect(r.spokenText).toContain('Body');
        expect(r.spokenText).toContain('Footnote: The detail');
    });
});

describe('markdown-to-prose: math + html blocks', () => {
    it('math block → "[math block omitted]"', () => {
        const md = '$$\\int_0^1 x dx$$';
        expect(transform(md).spokenText).toBe('[math block omitted]');
    });

    it('html block opens and closes with placeholder', () => {
        const md = '<div>\nignored\n</div>';
        const r = transform(md);
        expect(r.spokenText).toContain('[html block omitted]');
        expect(r.warnings).toContain('html-block');
    });
});

describe('markdown-to-prose: warnings array', () => {
    it('reports unsupported constructs in warnings', () => {
        const md = '$$x$$\n\n<div>\nhtml\n</div>';
        const r = transform(md);
        expect(r.warnings).toContain('math-block');
        expect(r.warnings).toContain('html-block');
    });

    it('deduplicates warnings', () => {
        const md = '$$a$$\n\n$$b$$';
        const r = transform(md);
        const mathCount = r.warnings.filter(w => w === 'math-block').length;
        expect(mathCount).toBe(1);
    });
});

describe('markdown-to-prose: stats', () => {
    it('charCount matches output length', () => {
        const r = transform('Hello world.');
        expect(r.stats.charCount).toBe(r.spokenText.length);
    });

    it('wordCount roughly matches', () => {
        const r = transform('One two three four.');
        expect(r.stats.wordCount).toBe(4);
    });

    it('estReadSeconds is non-negative', () => {
        const r = transform('Some text here.');
        expect(r.stats.estReadSeconds).toBeGreaterThanOrEqual(0);
    });
});

describe('markdown-to-prose: integration', () => {
    it('handles a realistic mixed note', () => {
        const md = `---
title: Travel
tags: [trip]
---

# Cyprus trip

Quick day plan for the Akamas peninsula.

## Stops

| Stop | Drive | Highlights |
|------|-------|------------|
| Aphrodite's Rock | 35 min | birthplace |
| Avakas Gorge | 25 min | hike |

## Notes

- Bring water
- Sunscreen
- [Map](https://map.com)

> [!warning] Don't forget passport

## Sources

See [[Other Note]] for details.

%% private %%

End.`;
        const r = transform(md);
        expect(r.spokenText).toContain('Note title: Cyprus trip');
        expect(r.spokenText).toContain('Section: Stops');
        expect(r.spokenText).toContain("Aphrodite");
        expect(r.spokenText).toContain('Bring water');
        expect(r.spokenText).toContain('Map');
        expect(r.spokenText).toContain('Warning: Don');
        expect(r.spokenText).toContain('Other Note');
        expect(r.spokenText).not.toContain('private');
        expect(r.spokenText).not.toContain('---');
    });
});
