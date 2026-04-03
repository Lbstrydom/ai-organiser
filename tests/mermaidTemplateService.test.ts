import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import {
    MermaidTemplateService,
    FALLBACK_TEMPLATES,
    MermaidTemplate,
} from '../src/services/mermaidTemplateService';
import { App, TFile } from './mocks/obsidian';

// ---------------------------------------------------------------------------
// Helper: build a minimal plugin stub
// ---------------------------------------------------------------------------
function createMockPlugin(overrides: Record<string, any> = {}) {
    return {
        settings: {
            pluginFolder: 'AI-Organiser',
            configFolderPath: 'Config',
        },
        configService: {
            getConfigPaths: () => ({
                mermaidTemplates: 'AI-Organiser/Config/mermaid-templates.md',
            }),
        },
        ...overrides,
    } as any;
}

function createService(appOverrides: Record<string, any> = {}, pluginOverrides: Record<string, any> = {}) {
    const app = new App();
    Object.assign(app.vault, appOverrides);
    const plugin = createMockPlugin(pluginOverrides);
    return { service: new MermaidTemplateService(app as any, plugin), app };
}

// ---------------------------------------------------------------------------
// FALLBACK_TEMPLATES
// ---------------------------------------------------------------------------
describe('FALLBACK_TEMPLATES', () => {
    it('has exactly 4 templates', () => {
        expect(FALLBACK_TEMPLATES).toHaveLength(4);
    });

    it('every template has name, description, type, and code', () => {
        for (const t of FALLBACK_TEMPLATES) {
            expect(t.name).toBeTruthy();
            expect(t.description).toBeTruthy();
            expect(t.type).toBeTruthy();
            expect(t.code).toBeTruthy();
        }
    });
});

// ---------------------------------------------------------------------------
// parseTemplateFile — pure function tests
// ---------------------------------------------------------------------------
describe('parseTemplateFile', () => {
    let service: MermaidTemplateService;

    beforeEach(() => {
        ({ service } = createService());
    });

    it('returns empty array for empty string', () => {
        expect(service.parseTemplateFile('')).toEqual([]);
    });

    it('returns empty array when content has no templates (just prose)', () => {
        const prose = 'This is just some random text.\nNo headings or code blocks here.';
        expect(service.parseTemplateFile(prose)).toEqual([]);
    });

    it('parses a single template with type tag', () => {
        const content = [
            '### My Flow [type: flowchart]',
            '> A simple flow.',
            '',
            '```mermaid',
            'flowchart TD',
            '    A --> B',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('My Flow');
        expect(result[0].type).toBe('flowchart');
        expect(result[0].description).toBe('A simple flow.');
        expect(result[0].code).toBe('flowchart TD\n    A --> B');
    });

    it('infers type from code when type tag is absent', () => {
        const content = [
            '### Sequence Example',
            '',
            '```mermaid',
            'sequenceDiagram',
            '    A->>B: Hello',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('sequenceDiagram');
    });

    it('parses multiple templates separated by ---', () => {
        const content = [
            '### Template A [type: flowchart]',
            '> Desc A',
            '',
            '```mermaid',
            'flowchart TD',
            '    A --> B',
            '```',
            '---',
            '### Template B [type: gantt]',
            '> Desc B',
            '',
            '```mermaid',
            'gantt',
            '    title Plan',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('Template A');
        expect(result[1].name).toBe('Template B');
    });

    it('parses description from > line', () => {
        const content = [
            '### Desc Test [type: flowchart]',
            '> This is the description.',
            '',
            '```mermaid',
            'flowchart LR',
            '    X --> Y',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result[0].description).toBe('This is the description.');
    });

    it('returns empty description when no > line present', () => {
        const content = [
            '### No Desc [type: mindmap]',
            '',
            '```mermaid',
            'mindmap',
            '  root((Topic))',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result[0].description).toBe('');
    });

    it('handles multiline code blocks', () => {
        const content = [
            '### Multi [type: flowchart]',
            '',
            '```mermaid',
            'flowchart TD',
            '    A([Start]) --> B[Step 1]',
            '    B --> C[Step 2]',
            '    C --> D{Decision}',
            '    D -->|Yes| E([End])',
            '    D -->|No| B',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(1);
        expect(result[0].code.split('\n')).toHaveLength(6);
        expect(result[0].code).toContain('D{Decision}');
    });

    it('skips section with missing ### header', () => {
        const content = [
            'No header here',
            '',
            '```mermaid',
            'flowchart TD',
            '    A --> B',
            '```',
        ].join('\n');

        expect(service.parseTemplateFile(content)).toEqual([]);
    });

    it('skips section with missing code block', () => {
        const content = [
            '### Header Only [type: flowchart]',
            '> Description but no code.',
        ].join('\n');

        expect(service.parseTemplateFile(content)).toEqual([]);
    });

    it('strips type tag from display name', () => {
        const content = [
            '### Cool Diagram [type: sequenceDiagram]',
            '',
            '```mermaid',
            'sequenceDiagram',
            '    A->>B: msg',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result[0].name).toBe('Cool Diagram');
        expect(result[0].name).not.toContain('[type:');
    });

    it('handles various diagram types (flowchart, sequenceDiagram, mindmap)', () => {
        const sections = [
            '### F [type: flowchart]\n\n```mermaid\nflowchart TD\n    A --> B\n```',
            '### S [type: sequenceDiagram]\n\n```mermaid\nsequenceDiagram\n    A->>B: Hi\n```',
            '### M [type: mindmap]\n\n```mermaid\nmindmap\n  root((X))\n```',
        ].join('\n---\n');

        const result = service.parseTemplateFile(sections);
        expect(result).toHaveLength(3);
        expect(result.map(t => t.type)).toEqual(['flowchart', 'sequenceDiagram', 'mindmap']);
    });

    it('preserves indentation in code', () => {
        const content = [
            '### Indented [type: mindmap]',
            '',
            '```mermaid',
            'mindmap',
            '  root((Topic))',
            '    Branch A',
            '      Leaf 1',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result[0].code).toContain('  root((Topic))');
        expect(result[0].code).toContain('    Branch A');
        expect(result[0].code).toContain('      Leaf 1');
    });

    it('parses 5 templates in one file', () => {
        const makeSection = (i: number) => [
            `### Template ${i} [type: flowchart]`,
            `> Description ${i}`,
            '',
            '```mermaid',
            'flowchart TD',
            `    A${i} --> B${i}`,
            '```',
        ].join('\n');

        const content = Array.from({ length: 5 }, (_, i) => makeSection(i + 1)).join('\n---\n');
        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(5);
        expect(result[4].name).toBe('Template 5');
    });

    it('ignores content before the first ### header', () => {
        const content = [
            '# Mermaid Diagram Templates',
            '',
            'Some intro text that should be ignored.',
            '',
            '---',
            '### Actual Template [type: flowchart]',
            '> The real template.',
            '',
            '```mermaid',
            'flowchart TD',
            '    A --> B',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Actual Template');
    });

    it('handles malformed type tag gracefully', () => {
        const content = [
            '### Broken Tag [type:]',
            '',
            '```mermaid',
            'gantt',
            '    title Timeline',
            '```',
        ].join('\n');

        const result = service.parseTemplateFile(content);
        expect(result).toHaveLength(1);
        // Malformed tag extracts empty string; type is inferred from code
        expect(result[0].name).toBe('Broken Tag');
        // The regex captures empty string from [type:], but code inference kicks in
        // since the type would be empty string (falsy handled by || in code inference)
        expect(result[0].type).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// loadTemplates — mock-based tests
// ---------------------------------------------------------------------------
describe('loadTemplates', () => {
    it('returns FALLBACK_TEMPLATES when config file does not exist', async () => {
        const { service } = createService({
            getAbstractFileByPath: () => null,
        });

        const result = await service.loadTemplates();
        expect(result).toBe(FALLBACK_TEMPLATES);
    });

    it('returns parsed templates when config file exists', async () => {
        const fileContent = [
            '### Custom Flow [type: flowchart]',
            '> My custom flowchart.',
            '',
            '```mermaid',
            'flowchart LR',
            '    X --> Y --> Z',
            '```',
        ].join('\n');

        const mockFile = new TFile();
        mockFile.path = 'AI-Organiser/Config/mermaid-templates.md';

        const { service } = createService({
            getAbstractFileByPath: () => mockFile,
            cachedRead: vi.fn().mockResolvedValue(fileContent),
        });

        const result = await service.loadTemplates();
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Custom Flow');
        expect(result[0].type).toBe('flowchart');
        expect(result[0].code).toBe('flowchart LR\n    X --> Y --> Z');
    });
});
