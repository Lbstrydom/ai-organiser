/**
 * DictionaryService tests (production-driven)
 * All assertions exercise the real service via mocked vault I/O.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App, TFile, TFolder } from './mocks/obsidian';
import { DictionaryService, Dictionary } from '../src/services/dictionaryService';

describe('DictionaryService', () => {
    let app: App;
    let service: DictionaryService;
    const configFolder = 'AI-Organiser/Config';

    // Simple in-memory vault model for dictionary tests
    let fileContents: Map<string, string>;
    let folders: Map<string, TFolder>;
    let files: Map<string, TFile>;

    function ensureFolder(path: string): TFolder {
        let folder = folders.get(path);
        if (!folder) {
            folder = new TFolder(path);
            folders.set(path, folder);
        }
        return folder;
    }

    function attachFile(path: string, content: string): TFile {
        const file = new TFile(path);
        files.set(path, file);
        fileContents.set(path, content);

        const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        if (parentPath) {
            const parent = ensureFolder(parentPath);
            if (!parent.children.some(child => child.path === file.path)) {
                parent.children.push(file);
            }
        }
        return file;
    }

    function installVaultMocks(): void {
        app.vault.getAbstractFileByPath = (path: string) => folders.get(path) ?? files.get(path) ?? null;
        app.vault.createFolder = async (path: string) => {
            ensureFolder(path);
        };
        app.vault.create = async (path: string, content: string) => attachFile(path, content);
        app.vault.modify = async (file: TFile, content: string) => {
            fileContents.set(file.path, content);
        };
        app.vault.read = async (file: TFile) => fileContents.get(file.path) ?? '';
        app.vault.delete = async (file: TFile) => {
            files.delete(file.path);
            fileContents.delete(file.path);
        };
    }

    beforeEach(() => {
        app = new App();
        service = new DictionaryService(app as any, configFolder);
        fileContents = new Map();
        folders = new Map();
        files = new Map();
        installVaultMocks();
        vi.clearAllMocks();
    });

    describe('createEmptyDictionary', () => {
        it('creates a dictionary with a slug id', () => {
            const dict = service.createEmptyDictionary('Acme Project Team');
            expect(dict.id).toBe('acme-project-team');
            expect(dict.entries).toHaveLength(0);
        });

        it('handles special characters in names', () => {
            const dict = service.createEmptyDictionary('Test & Co. (2025)');
            expect(dict.id).toBe('test-co-2025');
        });
    });

    describe('formatForPrompt', () => {
        it('formats populated dictionaries', () => {
            const dict = service.createEmptyDictionary('Test Dictionary');
            dict.entries = [
                { term: 'John Smith', category: 'person', definition: 'CEO' },
                { term: 'API', category: 'acronym', definition: 'Application Programming Interface' }
            ];

            const prompt = service.formatForPrompt(dict);

            expect(prompt).toContain('<dictionary name="Test Dictionary">');
            expect(prompt).toContain('<persons>');
            expect(prompt).toContain('- John Smith: CEO');
            expect(prompt).toContain('<acronyms>');
        });

        it('returns empty string for empty dictionaries', () => {
            const dict = service.createEmptyDictionary('Empty');
            expect(service.formatForPrompt(dict)).toBe('');
        });
    });

    describe('parseExtractionResponse', () => {
        it('parses valid JSON arrays', () => {
            const response = `[
                {"term": "John Smith", "category": "person", "definition": "CEO"},
                {"term": "API", "category": "acronym", "definition": "Application Programming Interface"}
            ]`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(2);
        });

        it('handles markdown code fences', () => {
            const response = "```json\n[{\"term\": \"Test\", \"category\": \"term\"}]\n```";
            const result = service.parseExtractionResponse(response);
            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(1);
        });

        it('rejects invalid JSON', () => {
            const result = service.parseExtractionResponse('not json');
            expect(result.success).toBe(false);
        });
    });

    describe('loadDictionary parsing via production path', () => {
        function mockDictionaryFile(content: string, filename = 'test-dict.md') {
            const path = `${service.getDictionariesFolder()}/${filename}`;
            ensureFolder(service.getDictionariesFolder());
            attachFile(path, content);
            return path;
        }

        it('parses frontmatter metadata and categories', async () => {
            const path = mockDictionaryFile(`---
name: Test Dictionary
description: For testing
---

## People
- **John Smith** - CEO

## Acronyms
- **API** - Application Programming Interface
`);

            const dict = await service.loadDictionary(path);

            expect(dict?.name).toBe('Test Dictionary');
            expect(dict?.description).toBe('For testing');
            expect(dict?.entries.some(e => e.category === 'person')).toBe(true);
            expect(dict?.entries.some(e => e.category === 'acronym')).toBe(true);
        });

        it('parses aliases and simple non-bold formats', async () => {
            const path = mockDictionaryFile(`## Terms
- Sprint velocity - Measure of work per sprint

## People
- John Smith (JS) - CEO
`);

            const dict = await service.loadDictionary(path);

            const sprint = dict?.entries.find(e => e.term === 'Sprint velocity');
            const john = dict?.entries.find(e => e.term === 'John Smith');

            expect(sprint?.definition).toBe('Measure of work per sprint');
            expect(john?.aliases).toContain('JS');
        });

        it('returns null when file does not exist', async () => {
            const dict = await service.loadDictionary('missing.md');
            expect(dict).toBeNull();
        });
    });

    describe('listDictionaries', () => {
        it('returns empty array when dictionaries folder missing', async () => {
            const dictionaries = await service.listDictionaries();
            expect(dictionaries).toEqual([]);
        });

        it('loads and sorts dictionaries by name', async () => {
            const folderPath = service.getDictionariesFolder();
            const folder = ensureFolder(folderPath);

            const alphaPath = `${folderPath}/alpha.md`;
            const zetaPath = `${folderPath}/zeta.md`;
            const alphaFile = attachFile(alphaPath, '---\nname: Alpha\n---');
            const zetaFile = attachFile(zetaPath, '---\nname: Zeta\n---');
            folder.children = [zetaFile, alphaFile];

            const dictionaries = await service.listDictionaries();

            expect(dictionaries.map(d => d.name)).toEqual(['Alpha', 'Zeta']);
        });
    });

    describe('saveDictionary', () => {
        it('creates a new dictionary file when missing', async () => {
            const dict = service.createEmptyDictionary('New Dictionary', 'A new dictionary');
            dict.entries = [{ term: 'Test Term', category: 'term', definition: 'A test' }];

            const path = await service.saveDictionary(dict);
            const saved = fileContents.get(path) ?? '';

            expect(path).toContain('new-dictionary.md');
            expect(saved).toContain('name: New Dictionary');
            expect(saved).toContain('## Terms');
            expect(saved).toContain('- **Test Term** - A test');
        });

        it('modifies existing dictionary files', async () => {
            const dict = service.createEmptyDictionary('Existing');
            const path = `${service.getDictionariesFolder()}/${dict.id}.md`;
            ensureFolder(service.getDictionariesFolder());
            attachFile(path, '---\nname: Existing\n---');

            dict.entries = [{ term: 'API', category: 'acronym' }];
            await service.saveDictionary(dict);

            const saved = fileContents.get(path) ?? '';
            expect(saved).toContain('## Acronyms');
            expect(saved).toContain('- **API**');
        });
    });
});
