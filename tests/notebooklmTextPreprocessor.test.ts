import { describe, it, expect } from 'vitest';
import { preprocessNoteForNotebookLM, PREPROCESSOR_VERSION } from '../src/services/notebooklm/textPreprocessor';

const baseOpts = { includeFrontmatter: false, includeTitle: false, title: '' };

describe('PREPROCESSOR_VERSION', () => {
    it('exports a numeric version constant', () => {
        expect(typeof PREPROCESSOR_VERSION).toBe('number');
        expect(PREPROCESSOR_VERSION).toBeGreaterThanOrEqual(1);
    });
});

describe('preprocessNoteForNotebookLM — title injection', () => {
    it('prepends title heading when includeTitle is true', () => {
        const result = preprocessNoteForNotebookLM('Content', { ...baseOpts, includeTitle: true, title: 'My Note' });
        expect(result.startsWith('# My Note\n')).toBe(true);
        expect(result).toContain('Content');
    });

    it('skips title when includeTitle is false', () => {
        const result = preprocessNoteForNotebookLM('Content', baseOpts);
        expect(result).not.toContain('#');
        expect(result).toContain('Content');
    });

    it('skips title when title is empty even if includeTitle is true', () => {
        const result = preprocessNoteForNotebookLM('Content', { ...baseOpts, includeTitle: true, title: '' });
        expect(result).not.toMatch(/^#/);
    });
});

describe('preprocessNoteForNotebookLM — YAML frontmatter', () => {
    const withFrontmatter = `---
title: My Note
tags: [obsidian, test]
---

Body content here.`;

    it('strips frontmatter when includeFrontmatter is false', () => {
        const result = preprocessNoteForNotebookLM(withFrontmatter, baseOpts);
        expect(result).not.toContain('title: My Note');
        expect(result).not.toContain('tags:');
        expect(result).toContain('Body content here.');
    });

    it('includes frontmatter when includeFrontmatter is true', () => {
        const result = preprocessNoteForNotebookLM(withFrontmatter, { ...baseOpts, includeFrontmatter: true });
        expect(result).toContain('title: My Note');
        expect(result).toContain('tags:');
        expect(result).toContain('Body content here.');
    });

    it('handles content with no frontmatter', () => {
        const content = 'Just plain content.';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toBe('Just plain content.');
    });
});

describe('preprocessNoteForNotebookLM — fenced blocks', () => {
    it('strips dataview fences', () => {
        const content = `Before\n\`\`\`dataview\nLIST\n\`\`\`\nAfter`;
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('dataview');
        expect(result).not.toContain('LIST');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('strips dataviewjs fences', () => {
        const content = `Before\n\`\`\`dataviewjs\nconst x = 1;\n\`\`\`\nAfter`;
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('dataviewjs');
        expect(result).not.toContain('const x = 1');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('preserves code fences', () => {
        const content = "Before\n```js\nconsole.log('hi');\n```\nAfter";
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('```js');
        expect(result).toContain("console.log('hi');");
        expect(result).toContain('```');
    });

    it('preserves mermaid fences', () => {
        const content = 'Before\n```mermaid\ngraph TD; A-->B\n```\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('```mermaid');
        expect(result).toContain('graph TD');
    });

    it('preserves math fences', () => {
        const content = 'Before\n```math\nE = mc^2\n```\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('```math');
        expect(result).toContain('E = mc^2');
    });

    it('handles tilde fences', () => {
        const content = 'Before\n~~~dataview\nLIST\n~~~\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('LIST');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });
});

describe('preprocessNoteForNotebookLM — Obsidian comments', () => {
    it('strips inline %% comments %%', () => {
        const content = 'Normal text %%this is a comment%% more text';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('this is a comment');
        expect(result).toContain('Normal text');
        expect(result).toContain('more text');
    });

    it('strips block %% comments', () => {
        const content = 'Before\n%%\nThis is a block comment\nMultiple lines\n%%\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('This is a block comment');
        expect(result).not.toContain('Multiple lines');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('strips block comment opened and closed with %%', () => {
        // A standalone %% opens the block; a second %% (on the same or later line) closes it
        const content = 'Before\n%%\nHidden content\n%%\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('Before');
        expect(result).not.toContain('Hidden content');
        expect(result).toContain('After');
    });
});

describe('preprocessNoteForNotebookLM — HTML blocks', () => {
    it('strips HTML div blocks', () => {
        const content = 'Before\n<div class="callout">\nSome HTML\n\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('<div');
        expect(result).not.toContain('Some HTML');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('strips HTML table blocks', () => {
        const content = 'Before\n<table>\n<tr><td>Cell</td></tr>\n\nAfter';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('<table>');
        expect(result).not.toContain('Cell');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });
});

describe('preprocessNoteForNotebookLM — image embeds', () => {
    it('replaces wiki-link image embeds ![[img.png]]', () => {
        const content = 'Before ![[screenshot.png]] After';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('![[screenshot.png]]');
        expect(result).toContain('[Image: screenshot]');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('replaces markdown image syntax ![alt](url.jpg)', () => {
        const content = 'Look: ![diagram](./assets/diagram.jpg)';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).not.toContain('![diagram]');
        expect(result).toContain('[Image: diagram]');
    });

    it('preserves non-image wiki embeds ![[note]]', () => {
        const content = 'Embed: ![[my-note]]';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('![[my-note]]');
    });

    it('preserves non-image markdown embeds ![](file.pdf)', () => {
        const content = 'File: ![doc](report.pdf)';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('![doc](report.pdf)');
    });

    it('handles wiki-link image with alias ![[img.png|My Image]]', () => {
        const content = '![[photo.jpg|My Photo]]';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('[Image: photo]');
    });

    it('handles image with path prefix ![[assets/photo.jpg]]', () => {
        const content = '![[assets/subfolder/photo.jpeg]]';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('[Image: photo]');
    });

    it('handles all common image extensions', () => {
        for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']) {
            const content = `![[img.${ext}]]`;
            const result = preprocessNoteForNotebookLM(content, baseOpts);
            expect(result).toContain('[Image: img]');
            expect(result).not.toContain(`![[img.${ext}]]`);
        }
    });
});

describe('preprocessNoteForNotebookLM — passthrough content', () => {
    it('preserves headings', () => {
        const content = '# Heading 1\n## Heading 2\nContent';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('# Heading 1');
        expect(result).toContain('## Heading 2');
    });

    it('preserves links [[wikilink]] and [text](url)', () => {
        const content = 'See [[other note]] and [example](https://example.com)';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('[[other note]]');
        expect(result).toContain('[example](https://example.com)');
    });

    it('preserves bullet lists', () => {
        const content = '- Item 1\n- Item 2\n  - Nested';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('- Item 1');
        expect(result).toContain('- Item 2');
        expect(result).toContain('  - Nested');
    });

    it('preserves numbered lists', () => {
        const content = '1. First\n2. Second';
        const result = preprocessNoteForNotebookLM(content, baseOpts);
        expect(result).toContain('1. First');
        expect(result).toContain('2. Second');
    });

    it('handles empty content', () => {
        const result = preprocessNoteForNotebookLM('', baseOpts);
        expect(result).toBe('');
    });
});

describe('preprocessNoteForNotebookLM — combined scenarios', () => {
    it('handles a realistic note with multiple element types', () => {
        const note = `---
title: Research Note
tags: [research]
---

# Research Note

This is my research on [[Topic A]].

%%draft - not ready%%

\`\`\`dataview
LIST FROM #research
\`\`\`

## Key Findings

- Finding 1 with ![[diagram.png]]
- Finding 2

\`\`\`js
const summary = compute();
\`\`\`

End of note.`;

        const result = preprocessNoteForNotebookLM(note, baseOpts);
        expect(result).not.toContain('title: Research Note');      // frontmatter stripped
        expect(result).not.toContain('draft - not ready');         // comment stripped
        expect(result).not.toContain('LIST FROM #research');       // dataview stripped
        expect(result).toContain('[Image: diagram]');              // image replaced
        expect(result).toContain('# Research Note');               // heading preserved
        expect(result).toContain('[[Topic A]]');                   // wikilink preserved
        expect(result).toContain('const summary = compute()');     // code preserved
        expect(result).toContain('End of note.');                  // body preserved
    });
});
