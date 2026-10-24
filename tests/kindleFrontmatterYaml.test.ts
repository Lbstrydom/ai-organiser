/**
 * Kindle note frontmatter: real YAML serialisation, anchored fence detection,
 * note-only highlights on incremental append, and fail-closed sync on an unsafe edit.
 */
vi.mock('../src/services/kindle/kindleAuthService', () => ({
    getStoredCookies: vi.fn().mockResolvedValue(null),
    clearCookies: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/kindle/kindleScraperService', () => ({ fetchAllHighlights: vi.fn() }));
vi.mock('../src/core/settings', () => ({
    getKindleOutputFullPath: vi.fn((s: Record<string, string>) => `${s.pluginFolder}/${s.kindleOutputFolder}`),
}));
vi.mock('../src/utils/minutesUtils', () => ({
    sanitizeFileName: (name: string) => name.replace(/[\\/:*?"<>|]/g, '-'),
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    getAvailableFilePath: vi.fn((_v: unknown, folder: string, filename: string) => Promise.resolve(`${folder}/${filename}`)),
}));

import * as yaml from 'js-yaml';
import { TFile } from 'obsidian';
import {
    buildFrontmatter,
    updateFrontmatterInContent,
    appendHighlightsToExisting,
} from '../src/services/kindle/kindleNoteBuilder';
import { syncFromClippings } from '../src/services/kindle/kindleSyncService';
import { generateBookKey } from '../src/services/kindle/kindleTypes';
import type { KindleBook, KindleHighlight } from '../src/services/kindle/kindleTypes';

function book(overrides: Partial<KindleBook> = {}): KindleBook {
    return { title: 'A Book', author: 'An Author', highlightCount: 1, highlights: [], ...overrides };
}

function hl(overrides: Partial<KindleHighlight> = {}): KindleHighlight {
    return { id: 'kh-1', text: 'Some text.', page: 3, location: '10-11', ...overrides };
}

/** Parse the frontmatter block of a note with a real YAML parser. */
function fm(note: string): Record<string, unknown> {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note);
    if (!m) throw new Error('no frontmatter');
    return yaml.load(m[1]) as Record<string, unknown>;
}

/** The pre-fix serialiser, kept to prove byte identity for values it handled correctly. */
function oldScalar(value: string): string {
    const needsQuotes = /[:#{}[\],&*?|<>=!%@`]/.test(value) || value.includes('\n');
    return needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
}

const AWKWARD = [
    'Foo---Bar',
    'C:\\temp\\',
    'back\\slash: and colon',
    'trailing backslash\\',
    'He said "hi"',
    "it's",
    'multi\nline',
    '- leading dash',
    '# hash',
    '&anchor',
    '!tag',
    '*star',
    '? q',
    '@at',
    '`tick',
    'yes',
    'null',
    '123',
    '0x1F',
    '1e3',
    ' padded ',
    '2026-10-24',
    'Ünïcödé 日本語',
];

describe('buildFrontmatter serialisation', () => {
    it.each(AWKWARD)('round-trips title/author %j through a YAML parser', (value) => {
        const parsed = fm(buildFrontmatter(book({ title: value, author: value, asin: value })));
        expect(parsed.title).toBe(value);
        expect(parsed.author).toBe(value);
        expect(parsed.kindle_asin).toBe(value);
        expect(parsed.source).toBe('kindle');
        expect(parsed.tags).toEqual([]);
    });

    it('keeps the byte-identical output for values the old serialiser handled correctly', () => {
        for (const value of ['Plain Title', 'Foo:Bar', 'Book: A Study', 'Mixed # hash', 'say "x"', 'A, B']) {
            const out = buildFrontmatter(book({ title: value, author: 'Ann' }));
            expect(out).toContain(`\ntitle: ${oldScalar(value)}\n`);
            expect(out).toContain('\nauthor: Ann\n');
        }
        const out = buildFrontmatter(book({ asin: 'B00XXXXXXXX', highlightCount: 7 }));
        expect(out).toMatch(/^---\ntitle: A Book\nauthor: An Author\nsource: kindle\nhighlights_count: 7\nlast_synced: "\d{4}-[^"]+Z"\nkindle_asin: B00XXXXXXXX\ntags: \[\]\n---\n$/);
    });
});

describe('updateFrontmatterInContent delimiters', () => {
    it('a frontmatter value containing --- does not end the block early', () => {
        const note = buildFrontmatter(book({ title: 'Foo---Bar' })) + '# Foo---Bar\n\nbody\n';
        const out = updateFrontmatterInContent(note, { highlights_count: 9, last_synced: '2026-10-24T00:00:00.000Z' });
        const parsed = fm(out);
        expect(parsed.title).toBe('Foo---Bar');
        expect(parsed.highlights_count).toBe(9);
        expect(parsed.last_synced).toBe('2026-10-24T00:00:00.000Z');
        expect(out.endsWith('# Foo---Bar\n\nbody\n')).toBe(true);
    });

    it('a note with no frontmatter but a --- rule in the body is returned unchanged', () => {
        const note = '# Title\n\nintro\n\n---\n\nmiddle\n\n---\n\nend\n';
        expect(updateFrontmatterInContent(note, { highlights_count: 3 })).toBe(note);
    });

    it('does not treat a --- rule after the frontmatter as the closing fence', () => {
        const note = '---\ntitle: T\nhighlights_count: 1\n---\n\nbody\n\n---\n\nmore\n';
        const out = updateFrontmatterInContent(note, { highlights_count: 2 });
        expect(out).toBe('---\ntitle: T\nhighlights_count: 2\n---\n\nbody\n\n---\n\nmore\n');
    });

    it('updates keys with awkward string values safely', () => {
        for (const value of AWKWARD) {
            const out = updateFrontmatterInContent('---\ntitle: Old\n---\nbody', { title: value });
            expect(fm(out).title).toBe(value);
            expect(out.endsWith('\nbody')).toBe(true);
        }
    });

    it('appends a missing key before the closing fence', () => {
        const out = updateFrontmatterInContent('---\ntitle: T\n---\nbody', { highlights_count: 4 });
        expect(out).toBe('---\ntitle: T\nhighlights_count: 4\n---\nbody');
    });

    it('preserves CRLF line endings', () => {
        const out = updateFrontmatterInContent('---\r\ntitle: T\r\nhighlights_count: 1\r\n---\r\nbody\r\n', {
            highlights_count: 2,
            kindle_asin: 'B1',
        });
        expect(out).toBe('---\r\ntitle: T\r\nhighlights_count: 2\r\nkindle_asin: B1\r\n---\r\nbody\r\n');
    });

    it('handles empty frontmatter and a BOM', () => {
        expect(updateFrontmatterInContent('---\n---\nbody', { highlights_count: 1 })).toBe('---\nhighlights_count: 1\n---\nbody');
        const withBom = updateFrontmatterInContent('\uFEFF---\ntitle: T\n---\nbody', { highlights_count: 1 });
        expect(withBom.startsWith('\uFEFF---\n')).toBe(true);
        expect(fm(withBom.slice(1)).highlights_count).toBe(1);
    });

    it('replaces a multi-line existing value without orphan lines, including a blank line inside it', () => {
        const note = '---\ntitle: |\n  line one\n\n  line two\nhighlights_count: 1\ntags: []\n---\nbody';
        const out = updateFrontmatterInContent(note, { title: 'New' });
        expect(fm(out)).toEqual({ title: 'New', highlights_count: 1, tags: [] });
        expect(out.endsWith('\nbody')).toBe(true);
    });

    it('updates a quoted key in place instead of adding a duplicate', () => {
        const out = updateFrontmatterInContent('---\n"title": Old\nx: 1\n---\nbody', { title: 'New' });
        expect(fm(out)).toEqual({ title: 'New', x: 1 });
    });

    it('throws (never silently corrupts) when the edit cannot be verified', () => {
        // flow-style mapping: a block-style line appended inside it cannot be a valid result
        const note = '---\n{title: T, highlights_count: 1}\n---\nbody';
        expect(() => updateFrontmatterInContent(note, { highlights_count: 2 })).toThrow(/frontmatter could not be updated safely/);
    });
});

const noteOnlyHighlight = () => hl({ id: 'kh-n', text: '', note: 'my thought' });

describe('appendHighlightsToExisting note-only highlights', () => {
    const noteOnly = hl({ id: 'kh-n', text: '', note: 'my thought' });

    it('appends a note-only highlight to an existing Notes section', () => {
        const existing = '# B\n\n## Highlights\n\n> old\n\n## Notes\n\n> [!note] Page 1\n> first\n';
        const out = appendHighlightsToExisting(existing, [noteOnly], 'blockquote');
        expect(out).toContain('> first\n\n> [!note] Page 3, Location 10-11\n> my thought');
        expect(out.match(/## Notes/g)).toHaveLength(1);
    });

    it('keeps note-only entries inside Notes when a user section follows it', () => {
        const existing = '# B\n\n## Notes\n\n> [!note]\n> first\n\n## My thoughts\n\nuser text\n';
        const out = appendHighlightsToExisting(existing, [noteOnly], 'blockquote');
        const notes = out.slice(out.indexOf('## Notes'), out.indexOf('## My thoughts'));
        expect(notes).toContain('my thought');
        expect(out.endsWith('## My thoughts\n\nuser text\n')).toBe(true);
    });

    it('creates a Notes section when absent', () => {
        const out = appendHighlightsToExisting('# B\n\n## Highlights\n\n> old\n', [noteOnly], 'blockquote');
        expect(out).toBe('# B\n\n## Highlights\n\n> old\n\n## Notes\n\n> [!note] Page 3, Location 10-11\n> my thought\n');
    });

    it('handles text and note-only together; text goes before Notes', () => {
        const existing = '# B\n\n## Highlights\n\n> old\n\n## Notes\n\n> [!note]\n> first\n';
        const out = appendHighlightsToExisting(existing, [hl({ text: 'fresh' }), noteOnly], 'bullet');
        expect(out.indexOf('- fresh')).toBeLessThan(out.indexOf('## Notes'));
        expect(out.indexOf('my thought')).toBeGreaterThan(out.indexOf('## Notes'));
    });

    it('a heading that merely starts with Notes is not the Notes section', () => {
        const existing = '# B\n\n## Notes on chapter 3\n\nmine\n';
        const out = appendHighlightsToExisting(existing, [hl({ text: 'fresh' })], 'bullet');
        expect(out).toBe(existing.trimEnd() + '\n\n- fresh — *Page 3, Location 10-11*\n');
    });

    it('a "## Notes" line inside a fenced code block is not the Notes section', () => {
        const existing = '---\ntitle: T\n---\n# B\n\n```md\n## Notes\n\n# not a heading\n```\n';
        const textOnly = appendHighlightsToExisting(existing, [hl({ text: 'fresh' })], 'bullet');
        expect(textOnly).toBe(existing.trimEnd() + '\n\n- fresh — *Page 3, Location 10-11*\n');
        const noteOnly = appendHighlightsToExisting(existing, [noteOnlyHighlight()], 'bullet');
        expect(noteOnly).toBe(existing.trimEnd() + '\n\n## Notes\n\n> [!note] Page 3, Location 10-11\n> my thought\n');
    });

    it('a heading-looking line inside a fence in the real Notes section does not end it', () => {
        const existing = '---\ntitle: T\n---\n# B\n\n## Notes\n\n```\n# fenced\n```\n\n## After\n\nmine\n';
        const out = appendHighlightsToExisting(existing, [noteOnlyHighlight()], 'bullet');
        expect(out.indexOf('my thought')).toBeLessThan(out.indexOf('## After'));
        expect(out.indexOf('my thought')).toBeGreaterThan(out.indexOf('# fenced'));
        expect(out.endsWith('## After\n\nmine\n')).toBe(true);
    });

    it('a "## Notes" line inside a list-item fence is not the Notes section', () => {
        const existing = '---\ntitle: T\n---\n# B\n\n- ```\n  ## Notes\n  ```\n';
        const out = appendHighlightsToExisting(existing, [noteOnlyHighlight()], 'bullet');
        expect(out).toBe(existing.trimEnd() + '\n\n## Notes\n\n> [!note] Page 3, Location 10-11\n> my thought\n');
    });

    it('fence containers: outdented line ends a list fence; 4-space delimiter does not close; 4-space opener is code', () => {
        const mk = (body: string) => '---\ntitle: T\n---\n# B\n\n' + body;
        const asNotes = (existing: string) => existing.trimEnd() + '\n\n## Notes\n\n> [!note] Page 3, Location 10-11\n> my thought\n';
        const cases = [
            mk('- ```text\n  example\n```\n## Notes\n```\n'),
            mk('```\n    ```\n## Notes\n```\n'),
        ];
        for (const existing of cases) {
            expect(appendHighlightsToExisting(existing, [noteOnlyHighlight()], 'bullet')).toBe(asNotes(existing));
        }
        const indentedCode = mk('    ```\n\n## Notes\nold\n');
        const out = appendHighlightsToExisting(indentedCode, [noteOnlyHighlight()], 'bullet');
        expect(out.match(/## Notes/g)).toHaveLength(1);
        expect(out.indexOf('my thought')).toBeGreaterThan(out.indexOf('old'));
    });

    it('backticks inside a YAML block scalar are not a Markdown fence', () => {
        for (const eol of ['\n', '\r\n']) {
            const existing = ['---', 'description: |', '  ```', '---', '# Book', '## Notes', 'old', '## Summary', 'keep', ''].join(eol);
            const out = appendHighlightsToExisting(existing, [noteOnlyHighlight()], 'bullet');
            expect(out.match(/## Notes/g)).toHaveLength(1);
            expect(out.indexOf('my thought')).toBeGreaterThan(out.indexOf('old'));
            expect(out.indexOf('my thought')).toBeLessThan(out.indexOf('## Summary'));
            const text = appendHighlightsToExisting(existing, [hl({ text: 'fresh' })], 'bullet');
            expect(text.indexOf('- fresh')).toBeLessThan(text.indexOf('## Notes'));
        }
    });

    it('text-only input is byte-identical to the previous behaviour', () => {
        const existing = '# B\n\n## Highlights\n\n> old\n\n## Notes\n\n> [!note]\n> first\n';
        const out = appendHighlightsToExisting(existing, [hl({ text: 'fresh' })], 'blockquote');
        const idx = existing.indexOf('\n## Notes');
        expect(out).toBe(existing.slice(0, idx) + '\n\n> fresh\n> — Page 3, Location 10-11' + existing.slice(idx));
        expect(appendHighlightsToExisting('# B\n', [hl({ text: 'fresh' })], 'blockquote')).toBe('# B\n\n> fresh\n> — Page 3, Location 10-11\n');
    });

    it('returns the input when nothing renders', () => {
        expect(appendHighlightsToExisting('# B\n', [hl({ text: '', note: undefined })], 'blockquote')).toBe('# B\n');
    });
});

describe('syncFromClippings fails closed when the frontmatter edit is unsafe', () => {
    it('records an error, writes nothing and does not advance bookkeeping', async () => {
        const b = book({
            highlights: [hl({ id: 'kh-new', text: 'brand new' })],
            highlightCount: 1,
        });
        const file = Object.assign(new TFile(), { path: 'AI-Organiser/Kindle/A Book - An Author.md' });
        const unsafe = '---\n{title: T, highlights_count: 1}\n---\n# A Book\n';
        const modify = vi.fn();
        const plugin = {
            settings: {
                kindleSyncState: { importedHighlights: {} as Record<string, string[]> },
                kindleHighlightStyle: 'blockquote',
                kindleGroupByColor: false,
                kindleIncludeCoverImage: false,
                kindleOutputFolder: 'Kindle',
                pluginFolder: 'AI-Organiser',
            },
            saveSettings: vi.fn(),
            app: {
                vault: {
                    getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
                    read: vi.fn().mockResolvedValue(unsafe),
                    modify,
                },
            },
        };
        const result = await syncFromClippings(plugin as never, [b], () => undefined);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/could not be updated safely/);
        expect(result.success).toBe(false);
        expect(result.highlightsImported).toBe(0);
        expect(modify).not.toHaveBeenCalled();
        expect(plugin.settings.kindleSyncState.importedHighlights[generateBookKey(b.title, b.author)]).toBeUndefined();
    });
});
