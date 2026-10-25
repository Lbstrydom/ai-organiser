/**
 * Dashboards are written in the native Bases schema. Obsidian 1.15 reads `filters` + `views`
 * (with `order`) and a bare property name; it ignores a top-level `columns:` and treats
 * `property.status` as unknown (measured: 0 results and a file-name column only). The old
 * template dialect is converted when a dashboard is created.
 */
import { vi, describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, createTFile, createTFolder } from './mocks/obsidian';
import { DashboardService, toNativeBase, validateBaseContent } from '../src/services/dashboardService';
import { DEFAULT_BASES_TEMPLATES } from '../src/services/configurationService';

/** The default template exactly as releases up to 1.1.1 wrote it into every user's bases-templates.md. */
const LEGACY_DEFAULT = `---
name: Notes Dashboard
description: AI-processed notes with summaries and metadata
filters: 'property.status == "processed"'
columns:
  - property.name
  - property.summary
  - property.persona
  - property.type
  - property.tags
  - property.processed`;

const load = (text: string) => yaml.load(text) as Record<string, any>;

/** What a Bases view needs to show anything at all. */
function expectNative(doc: Record<string, any>): void {
    expect(doc.columns).toBeUndefined();
    expect(Array.isArray(doc.views)).toBe(true);
    expect(doc.views[0].type).toBe('table');
    expect(Array.isArray(doc.views[0].order)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('property.');
}

describe('toNativeBase', () => {
    it('converts the legacy default template (what existing users have on disk)', () => {
        const doc = load(toNativeBase(LEGACY_DEFAULT));
        expectNative(doc);
        expect(doc.filters).toBe('status == "processed"');
        expect(doc.views[0].name).toBe('Notes Dashboard');
        expect(doc.views[0].order).toEqual(['file.name', 'summary', 'persona', 'type', 'tags', 'processed']);
        expect(doc.description).toBeUndefined();
        expect(doc.name).toBeUndefined();
    });

    it('the new default template is native and is returned unchanged', () => {
        const content = DEFAULT_BASES_TEMPLATES[0].content;
        expectNative(load(content));
        expect(load(content).filters).toBe('status == "processed"');
        expect(toNativeBase(content)).toBe(content);
    });

    it('returns a document that already has views byte-identical', () => {
        const native = 'filters:\n  and:\n    - file.hasTag("a")\nviews:\n  - type: cards\n    name: C\n';
        expect(toNativeBase(native)).toBe(native);
    });

    it('returns a document that is not template dialect unchanged', () => {
        const odd = 'filters: \'x == 1\'\nformulas:\n  a: "1"\n';
        expect(toNativeBase(odd)).toBe(odd);
    });

    it('does not touch property. inside a quoted literal', () => {
        const doc = load(toNativeBase('name: T\nfilters: \'property.kind == "property.status"\'\ncolumns:\n  - file.name\n'));
        expect(doc.filters).toBe('kind == "property.status"');
    });

    it('does not touch property. inside a single-quoted literal', () => {
        const src = 'name: T\nfilters: "property.kind == \'property.status\'"\ncolumns:\n  - file.name\n';
        expect(load(toNativeBase(src)).filters).toBe("kind == 'property.status'");
    });

    it('does not rewrite a qualified reference such as note.property.status', () => {
        const doc = load(toNativeBase('name: T\nfilters: \'note.property.status == 1 and property.a == 2\'\ncolumns:\n  - file.name\n'));
        expect(doc.filters).toBe('note.property.status == 1 and a == 2');
    });

    it('reads a template with a closing --- fence and keeps a native one byte-identical', () => {
        const fenced = '---\nname: T\nfilters: \'property.status == "x"\'\ncolumns:\n  - property.name\n---\n';
        const doc = load(toNativeBase(fenced));
        expectNative(doc);
        expect(doc.filters).toBe('status == "x"');
        const nativeFenced = '---\nfilters: \'a == 1\'\nviews:\n  - type: table\n    name: V\n---\n';
        expect(toNativeBase(nativeFenced)).toBe(nativeFenced);
    });

    it('does not mistake an indented --- inside a block scalar for the closing fence', () => {
        const src = '---\nname: T\nnote: |\n  line one\n  ---\n  line two\nfilters: \'property.status == "x"\'\ncolumns:\n  - file.name\n';
        const doc = load(toNativeBase(src));
        expectNative(doc);
        expect(doc.filters).toBe('status == "x"');
        expect(doc.note).toBe('line one\n---\nline two\n');
    });

    it('refuses a YAML alias cycle, a shared alias and absurd nesting instead of expanding them', () => {
        const cycle = 'name: T\nfilters: &f\n  and:\n    - *f\ncolumns:\n  - file.name\n';
        expect(() => toNativeBase(cycle)).toThrow(/nest too deeply or reuse a YAML alias/);
        const shared = 'name: T\nfilters:\n  and:\n    - &a\n      or:\n        - x\n    - *a\ncolumns:\n  - file.name\n';
        expect(() => toNativeBase(shared)).toThrow(/reuse a YAML alias/);
        let deep = "'x'";
        for (let i = 0; i < 40; i++) deep = `{and: [${deep}]}`;
        expect(() => toNativeBase(`name: T\nfilters: ${deep}\ncolumns:\n  - file.name\n`)).toThrow(/nest too deeply/);
    });

    it('rewrites nested and/or/not groups', () => {
        const src = 'name: T\nfilters:\n  and:\n    - \'property.a == 1\'\n    - or:\n        - \'property.b == 2\'\n        - not:\n            - \'property.c == 3\'\ncolumns:\n  - file.name\n';
        expect(load(toNativeBase(src)).filters).toEqual({ and: ['a == 1', { or: ['b == 2', { not: ['c == 3'] }] }] });
    });

    it('uses note["x"] for names that are not identifiers', () => {
        const doc = load(toNativeBase('name: T\nfilters: \'property.my-prop == 1\'\ncolumns:\n  - property.my-prop\n'));
        expect(doc.filters).toBe('note["my-prop"] == 1');
        expect(doc.views[0].order).toEqual(['note.my-prop']);
    });

    it('maps name and created columns and keeps file.* and other bare columns', () => {
        const doc = load(toNativeBase('name: T\ncolumns:\n  - name\n  - created\n  - file.mtime\n  - status\n'));
        expect(doc.views[0].order).toEqual(['file.name', 'file.ctime', 'file.mtime', 'status']);
    });

    it('keeps other top-level keys (properties, formulas)', () => {
        const doc = load(toNativeBase('name: T\nproperties:\n  status:\n    displayName: S\ncolumns:\n  - file.name\n'));
        expect(doc.properties).toEqual({ status: { displayName: 'S' } });
        expectNative(doc);
    });

    it('throws on invalid YAML like the other helpers', () => {
        expect(() => toNativeBase('name: [unclosed')).toThrow(/not valid YAML/);
    });

    it('its output passes the plugin validator', () => {
        expect(validateBaseContent(toNativeBase(LEGACY_DEFAULT))).toBeNull();
    });
});

describe('dashboards are created in the native schema', () => {
    function setup(templateContent: string, folderPath: string) {
        const app = new App();
        let created = '';
        app.vault.getAbstractFileByPath = () => null;
        app.vault.create = async (path: string, content: string) => { created = content; return createTFile(path); };
        const template = { name: 'Notes Dashboard', description: 'd', fileName: 'Notes Dashboard.base', category: 'default', content: templateContent };
        const plugin = {
            configService: { getBasesTemplateByName: vi.fn().mockResolvedValue(template) },
            basesService: { isBasesEnabled: vi.fn().mockReturnValue(false) },
        } as any;
        return { service: new DashboardService(app as any, plugin), folder: createTFolder(folderPath), created: () => created };
    }

    it.each([['legacy template on disk', LEGACY_DEFAULT], ['new default template', DEFAULT_BASES_TEMPLATES[0].content]])(
        'folder dashboard from the %s scopes the folder and keeps the status filter',
        async (_label, content) => {
            const { service, folder, created } = setup(content, 'Projects/Alpha');
            expect(await service.createDashboard({ template: 'Notes Dashboard', folder })).toBe(true);
            const doc = load(created());
            expectNative(doc);
            expect(doc.filters).toEqual({ and: ['file.inFolder("Projects/Alpha")', 'status == "processed"'] });
            expect(doc.views[0].order[0]).toBe('file.name');
        },
    );

    it('root dashboard from the legacy template is native too', async () => {
        const { service, folder, created } = setup(LEGACY_DEFAULT, '/');
        expect(await service.createDashboard({ template: 'Notes Dashboard', folder })).toBe(true);
        const doc = load(created());
        expectNative(doc);
        expect(doc.filters).toBe('status == "processed"');
    });

    it('a pasted template-dialect custom dashboard is written native', async () => {
        const { service, folder, created } = setup('', 'Dashboards');
        expect(await service.createCustomDashboard('Mine', 'name: Mine\nfilters: \'property.status == "active"\'\ncolumns:\n  - property.name\n  - status\n', folder)).toBe(true);
        const doc = load(created());
        expectNative(doc);
        expect(doc.filters).toBe('status == "active"');
        expect(doc.views[0].order).toEqual(['file.name', 'status']);
    });

    it('a pasted native custom dashboard is written byte-identical', async () => {
        const { service, folder, created } = setup('', 'Dashboards');
        const native = 'filters: \'status == "x"\'\nviews:\n  - type: table\n    name: V\n';
        expect(await service.createCustomDashboard('Mine', native, folder)).toBe(true);
        expect(created()).toBe(native);
    });
});
