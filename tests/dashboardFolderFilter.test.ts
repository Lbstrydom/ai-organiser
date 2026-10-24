/**
 * Dashboard folder scope: every filter shape yields exactly one valid `filters`
 * entry that ANDs the folder with the original filter, or throws. Validation is
 * structural, not substring-based.
 */
import { vi } from 'vitest';
import * as yaml from 'js-yaml';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { DashboardService, validateBaseContent } from '../src/services/dashboardService';

type Inject = { injectFolderFilter(content: string, folder: string): string };
const svc = Object.create(DashboardService.prototype) as Inject;
const inject = (content: string, folder: string) => svc.injectFolderFilter(content, folder);

/** The Bases string literal for a folder, as the plugin must write it. */
const expr = (folder: string) => `file.inFolder("${folder.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`;

function load(out: string): Record<string, unknown> {
    return yaml.load(out) as Record<string, unknown>;
}

function andList(out: string): unknown[] {
    const filters = load(out).filters as { and: unknown[] };
    return filters.and;
}

/** Decode the Bases literal back to the folder it names. */
function folderOf(literal: string): string {
    const m = /^file\.inFolder\("((?:[^"\\]|\\.)*)"\)$/.exec(literal);
    if (!m) throw new Error('not an inFolder literal: ' + literal);
    return m[1].replaceAll(/\\(.)/g, '$1');
}

const BODY = 'columns:\n  - file.name\n';

describe('injectFolderFilter shapes', () => {
    it.each([
        ["O'Brien"],
        ['C:\\Users\\me'],
        ['trailing\\'],
        ['Say "hi"'],
        ['Mix \'a\' "b" \\c'],
        ['Money $& more $1'],
        ['colon: space # hash'],
        ['日本語/ünï'],
    ])('folder %j round-trips through YAML and the Bases literal', (folder) => {
        for (const template of [
            `---\nname: T\n${BODY}`,
            `---\nname: T\nfilters: 'note.kind == "a"'\n${BODY}`,
            `---\nname: T\nfilters:\n  and:\n    - 'x'\n${BODY}`,
        ]) {
            const out = inject(template, folder);
            const filters = load(out).filters;
            const first = typeof filters === 'string' ? filters : (filters as { and: string[] }).and[0];
            expect(first).toBe(expr(folder));
            expect(folderOf(first)).toBe(folder);
        }
    });

    it('top-level or: is wrapped, not turned into a second filters key', () => {
        const out = inject(`---\nname: T\nfilters:\n  or:\n    - 'a == 1'\n    - 'b == 2'\n${BODY}`, 'Proj');
        expect(out.match(/^filters:/gm)).toHaveLength(1);
        expect(andList(out)).toEqual([expr('Proj'), { or: ['a == 1', 'b == 2'] }]);
    });

    it('not: is wrapped', () => {
        const out = inject(`---\nname: T\nfilters:\n  not:\n    - 'a == 1'\n${BODY}`, 'Proj');
        expect(andList(out)).toEqual([expr('Proj'), { not: ['a == 1'] }]);
    });

    it('existing and: gets the folder first and keeps the rest in order', () => {
        const out = inject(`---\nname: T\nfilters:\n  and:\n    - 'a == 1'\n    - or:\n        - 'b'\n        - 'c'\n${BODY}`, 'Proj');
        expect(andList(out)).toEqual([expr('Proj'), 'a == 1', { or: ['b', 'c'] }]);
    });

    it.each([
        ['double-quoted', `filters: "a == \\"x\\""`, 'a == "x"'],
        ['unquoted', 'filters: a == 1', 'a == 1'],
        ['single-quoted with doubled quote', `filters: 'it''s'`, "it's"],
        ['with a trailing comment', `filters: 'a == 1' # keep`, 'a == 1'],
    ])('%s string filter is preserved and ANDed', (_label, line, value) => {
        const out = inject(`---\nname: T\n${line}\n${BODY}`, 'Proj');
        expect(out.match(/^filters:/gm)).toHaveLength(1);
        expect(andList(out)).toEqual([expr('Proj'), value]);
    });

    it('a quoted filters key does not produce a duplicate key', () => {
        const out = inject(`---\nname: T\n"filters": 'a == 1'\n${BODY}`, 'Proj');
        expect(Object.keys(load(out)).filter(k => k === 'filters')).toHaveLength(1);
        expect(andList(out)).toEqual([expr('Proj'), 'a == 1']);
    });

    it('an empty filters: key is replaced by the folder filter', () => {
        const out = inject(`---\nname: T\nfilters:\n${BODY}`, 'Proj');
        expect(load(out).filters).toBe(expr('Proj'));
        expect(load(out).columns).toEqual(['file.name']);
    });

    it('keeps comments, other keys and the text after the filters block', () => {
        const template = `---\n# header comment\nname: T\nfilters:\n  and:\n    - 'a'\n\n# about columns\ncolumns:\n  - file.name\n`;
        const out = inject(template, 'Proj');
        expect(out).toContain('# header comment\n');
        expect(out).toContain('\n# about columns\ncolumns:\n  - file.name\n');
        expect(load(out).name).toBe('T');
    });

    it('a template with neither filters nor columns still gets scoped', () => {
        const out = inject('---\nname: T\n', 'Proj');
        expect(load(out)).toEqual({ name: 'T', filters: expr('Proj') });
    });

    it('native views templates are scoped at the root', () => {
        const out = inject('filters:\n  and:\n    - \'a\'\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n', 'Proj');
        expect(andList(out)).toEqual([expr('Proj'), 'a']);
        expect((load(out).views as unknown[]).length).toBe(1);
    });

    it('CRLF templates stay CRLF', () => {
        const out = inject(`---\r\nname: T\r\nfilters: 'a'\r\ncolumns:\r\n  - file.name\r\n`, 'Proj');
        expect(out.replaceAll('\r\n', '')).not.toContain('\n');
        expect(andList(out)).toEqual([expr('Proj'), 'a']);
    });

    it('root folder returns the template untouched', () => {
        expect(inject('---\nname: T\n', '/')).toBe('---\nname: T\n');
        expect(inject('---\nname: T\n', '')).toBe('---\nname: T\n');
    });
});

describe('injectFolderFilter fails closed', () => {
    it('unterminated flow sequence', () => {
        expect(() => inject('---\nname: T\ncolumns: [a, b\n', 'Proj')).toThrow(/not valid YAML/);
    });

    it('duplicate filters keys', () => {
        expect(() => inject(`---\nname: T\nfilters: 'a'\nfilters: 'b'\n${BODY}`, 'Proj')).toThrow(/not valid YAML/);
    });

    it('a flow-style root mapping cannot be scoped', () => {
        expect(() => inject('{name: T, columns: [a]}\n', 'Proj')).toThrow(/cannot be scoped/);
    });

    it('an indented root mapping cannot be scoped', () => {
        expect(() => inject('  name: T\n  columns:\n    - a\n', 'Proj')).toThrow(/cannot be scoped/);
    });

    it('multiple documents are rejected', () => {
        expect(() => inject('name: T\n---\nname: U\n', 'Proj')).toThrow(/not valid YAML/);
    });

    it('a non-mapping document is rejected', () => {
        expect(() => inject('- a\n- b\n', 'Proj')).toThrow(/not valid YAML|mapping/);
    });
});

describe('validateBaseContent', () => {
    const ok = (c: string) => expect(validateBaseContent(c)).toBeNull();
    const bad = (c: string) => expect(validateBaseContent(c)).toEqual(expect.any(String));

    it('accepts the plugin template dialect (with or without a leading fence)', () => {
        ok('---\nname: T\ncolumns:\n  - file.name\n');
        ok('name: T\ncolumns:\n  - file.name\n');
    });

    it('accepts the native Bases shape and unrelated keys', () => {
        ok('views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n');
        ok('filters: \'a\'\nformulas:\n  x: "1"\nviews:\n  - type: table\n');
        ok('name: T\ncolumns:\n  - file.name\nextra: {a: 1}\n');
    });

    it('rejects invalid YAML', () => {
        bad('name: T\ncolumns: [a, b\n');
        bad('---\nname: T\n---\nname: U\ncolumns: [a]\n');
    });

    it('rejects content that only mentions the words', () => {
        bad('# name: and columns: in a comment, with --- too\n');
        bad('just some prose with name: and columns: and ---');
    });

    it('rejects a mapping with neither shape', () => {
        bad('name: T\n');
        bad('columns:\n  - file.name\n');
        bad('name: T\ncolumns: file.name\n');
        bad('name: ""\ncolumns:\n  - a\n');
        bad('views: []\n');
        bad('views:\n  - not-a-mapping\n');
    });

    it('validates filters recursively, at the root and inside every view', () => {
        bad('name: T\ncolumns:\n  - a\nfilters:\n  typo: []\n');
        bad('name: T\ncolumns:\n  - a\nfilters:\n  and: 5\n');
        bad('name: T\ncolumns:\n  - a\nfilters:\n  and:\n    - or: nope\n');
        bad('name: T\ncolumns:\n  - a\nfilters: ""\n');
        bad('views:\n  - type: table\n    filters: 5\n');
        bad('views:\n  - type: table\n    filters:\n      and:\n        - unknownop: []\n');
        ok('views:\n  - type: table\n    filters:\n      and:\n        - \'a\'\n        - or:\n            - \'b\'\n            - not:\n                - \'c\'\n');
        ok('name: T\ncolumns:\n  - a\nfilters:\n  and:\n    - \'a\'\n    - or:\n        - \'b\'\n');
    });

    it('rejects cyclic aliases and absurd nesting instead of overflowing the stack', () => {
        bad('name: T\ncolumns:\n  - a\nfilters: &loop\n  and: [*loop]\n');
        bad('views:\n  - type: table\nfilters: &loop\n  and: [*loop]\n');
        bad('name: T\ncolumns:\n  - a\nfilters: &a\n  or:\n    - and: [*a]\n');
        let nested = "'x'";
        for (let i = 0; i < 200; i++) nested = `{and: [${nested}]}`;
        bad(`name: T\ncolumns:\n  - a\nfilters: ${nested}\n`);
    });

    it('accepts shared (non-cyclic) aliases without exponential work', () => {
        // each level references the previous one twice: 2^24 paths if visited naively
        const items = ["- &n0 {and: ['a']}"];
        for (let i = 1; i < 25; i++) items.push(`- &n${i} {and: [*n${i - 1}, *n${i - 1}]}`);
        ok(`name: T\ncolumns:\n  - a\nfilters:\n  and:\n    ${items.join('\n    ')}\n`);
    });

    it('applies the depth limit through shared aliases too', () => {
        const chain = (links: number) => {
            const items = ["- &f1 {and: ['true']}"];
            for (let i = 2; i <= links; i++) items.push(`- &f${i} {and: [*f${i - 1}]}`);
            return `name: T\ncolumns:\n  - a\nfilters:\n  and:\n    ${items.join('\n    ')}\n`;
        };
        ok(chain(10));
        bad(chain(33));
    });

    it('requires every view to be a mapping with a type', () => {
        bad('views:\n  - {}\n');
        bad('views:\n  - name: Table\n');
        bad('views:\n  - type: ""\n');
    });

    it('rejects a non-mapping filters value', () => {
        bad('name: T\ncolumns:\n  - a\nfilters:\n  - x\n');
        bad('name: T\ncolumns:\n  - a\nfilters: 5\n');
        ok('name: T\ncolumns:\n  - a\nfilters:\n');
    });
});
