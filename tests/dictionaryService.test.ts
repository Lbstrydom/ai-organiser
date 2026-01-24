/**
 * Dictionary Service Tests
 * Tests for terminology dictionary management and extraction
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { App, TFile, TFolder } from './mocks/obsidian';

// Replicate types from the actual service
interface DictionaryEntry {
    term: string;
    category: 'person' | 'acronym' | 'term' | 'project' | 'organization';
    definition?: string;
    aliases?: string[];
}

interface Dictionary {
    id: string;
    name: string;
    description: string;
    entries: DictionaryEntry[];
    createdAt: string;
    updatedAt: string;
}

// Mock DictionaryService for testing parsing logic
class MockDictionaryService {
    /**
     * Parse dictionary content from markdown
     */
    parseDictionaryContent(content: string, filename: string): Dictionary {
        const lines = content.split('\n');

        let name = filename;
        let description = '';
        let createdAt = new Date().toISOString();
        let updatedAt = new Date().toISOString();
        const entries: DictionaryEntry[] = [];

        let inFrontmatter = false;
        let frontmatterEnded = false;
        let currentCategory: DictionaryEntry['category'] | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // Handle frontmatter
            if (trimmed === '---') {
                if (!frontmatterEnded) {
                    inFrontmatter = !inFrontmatter;
                    if (!inFrontmatter) {
                        frontmatterEnded = true;
                    }
                }
                continue;
            }

            if (inFrontmatter) {
                const match = trimmed.match(/^(\w+):\s*(.+)$/);
                if (match) {
                    const [, key, value] = match;
                    switch (key.toLowerCase()) {
                        case 'name':
                            name = value;
                            break;
                        case 'description':
                            description = value;
                            break;
                        case 'created':
                            createdAt = value;
                            break;
                        case 'updated':
                            updatedAt = value;
                            break;
                    }
                }
                continue;
            }

            // Parse section headers
            if (trimmed.startsWith('## ')) {
                const sectionName = trimmed.substring(3).toLowerCase();
                if (sectionName.includes('people') || sectionName.includes('person')) {
                    currentCategory = 'person';
                } else if (sectionName.includes('acronym')) {
                    currentCategory = 'acronym';
                } else if (sectionName.includes('project')) {
                    currentCategory = 'project';
                } else if (sectionName.includes('organization') || sectionName.includes('organisation')) {
                    currentCategory = 'organization';
                } else if (sectionName.includes('term')) {
                    currentCategory = 'term';
                } else {
                    currentCategory = 'term'; // Default
                }
                continue;
            }

            // Parse entries (list items)
            if (currentCategory && trimmed.startsWith('- ')) {
                const entry = this.parseEntryLine(trimmed.substring(2), currentCategory);
                if (entry) {
                    entries.push(entry);
                }
            }
        }

        const id = filename.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        return {
            id,
            name,
            description,
            entries,
            createdAt,
            updatedAt
        };
    }

    /**
     * Parse a single entry line
     */
    private parseEntryLine(line: string, category: DictionaryEntry['category']): DictionaryEntry | null {
        // Match: **Term** optionally followed by (aliases) and/or - definition
        const match = line.match(/^\*\*([^*]+)\*\*(?:\s*\(([^)]+)\))?\s*(?:-\s*(.+))?$/);

        if (!match) {
            // Try simpler format without bold
            const simpleMatch = line.match(/^([^-]+?)(?:\s*\(([^)]+)\))?\s*(?:-\s*(.+))?$/);
            if (simpleMatch) {
                const [, term, aliasStr, definition] = simpleMatch;
                const aliases = aliasStr
                    ? aliasStr.split(',').map(a => a.trim()).filter(a => a)
                    : undefined;
                return {
                    term: term.trim(),
                    category,
                    definition: definition?.trim(),
                    aliases: aliases && aliases.length > 0 ? aliases : undefined
                };
            }
            return null;
        }

        const [, term, aliasStr, definition] = match;
        const aliases = aliasStr
            ? aliasStr.split(',').map(a => a.trim()).filter(a => a)
            : undefined;

        return {
            term: term.trim(),
            category,
            definition: definition?.trim(),
            aliases: aliases && aliases.length > 0 ? aliases : undefined
        };
    }

    /**
     * Generate markdown content for a dictionary
     */
    generateDictionaryContent(dictionary: Dictionary): string {
        const lines: string[] = [];

        // Frontmatter
        lines.push('---');
        lines.push(`name: ${dictionary.name}`);
        if (dictionary.description) {
            lines.push(`description: ${dictionary.description}`);
        }
        lines.push(`created: ${dictionary.createdAt}`);
        lines.push(`updated: ${dictionary.updatedAt}`);
        lines.push('---');
        lines.push('');

        // Group entries by category
        const categories: Record<DictionaryEntry['category'], DictionaryEntry[]> = {
            person: [],
            acronym: [],
            project: [],
            organization: [],
            term: []
        };

        for (const entry of dictionary.entries) {
            categories[entry.category].push(entry);
        }

        // Generate sections
        const categoryTitles: Record<DictionaryEntry['category'], string> = {
            person: 'People',
            acronym: 'Acronyms',
            project: 'Projects',
            organization: 'Organizations',
            term: 'Terms'
        };

        for (const [category, title] of Object.entries(categoryTitles)) {
            const entries = categories[category as DictionaryEntry['category']];
            if (entries.length > 0) {
                lines.push(`## ${title}`);
                lines.push('');
                for (const entry of entries) {
                    lines.push(this.formatEntryLine(entry));
                }
                lines.push('');
            }
        }

        return lines.join('\n');
    }

    /**
     * Format a single entry as a markdown list item
     */
    private formatEntryLine(entry: DictionaryEntry): string {
        let line = `- **${entry.term}**`;

        if (entry.aliases && entry.aliases.length > 0) {
            line += ` (${entry.aliases.join(', ')})`;
        }

        if (entry.definition) {
            line += ` - ${entry.definition}`;
        }

        return line;
    }

    /**
     * Format dictionary entries for injection into prompts
     */
    formatForPrompt(dictionary: Dictionary): string {
        if (dictionary.entries.length === 0) {
            return '';
        }

        const lines: string[] = [];
        lines.push(`<dictionary name="${dictionary.name}">`);

        // Group by category for cleaner output
        const categories: Record<string, DictionaryEntry[]> = {};
        for (const entry of dictionary.entries) {
            if (!categories[entry.category]) {
                categories[entry.category] = [];
            }
            categories[entry.category].push(entry);
        }

        for (const [category, entries] of Object.entries(categories)) {
            lines.push(`<${category}s>`);
            for (const entry of entries) {
                let entryLine = entry.term;
                if (entry.aliases && entry.aliases.length > 0) {
                    entryLine += ` (${entry.aliases.join(', ')})`;
                }
                if (entry.definition) {
                    entryLine += `: ${entry.definition}`;
                }
                lines.push(`- ${entryLine}`);
            }
            lines.push(`</${category}s>`);
        }

        lines.push('</dictionary>');
        return lines.join('\n');
    }

    /**
     * Create a new empty dictionary
     */
    createEmptyDictionary(name: string, description: string = ''): Dictionary {
        const id = name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const now = new Date().toISOString();

        return {
            id,
            name,
            description,
            entries: [],
            createdAt: now,
            updatedAt: now
        };
    }

    /**
     * Parse extraction response from LLM
     */
    parseExtractionResponse(response: string): { success: boolean; entries?: DictionaryEntry[]; error?: string } {
        try {
            let jsonStr = response.trim();
            jsonStr = jsonStr.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

            const start = jsonStr.indexOf('[');
            const end = jsonStr.lastIndexOf(']');

            if (start === -1 || end === -1 || end <= start) {
                return { success: false, error: 'No valid JSON array found in response' };
            }

            jsonStr = jsonStr.substring(start, end + 1);
            const parsed = JSON.parse(jsonStr);

            if (!Array.isArray(parsed)) {
                return { success: false, error: 'Response is not an array' };
            }

            const entries: DictionaryEntry[] = [];
            const validCategories = ['person', 'acronym', 'project', 'organization', 'term'];

            for (const item of parsed) {
                if (!item.term || !item.category) {
                    continue;
                }

                const category = item.category.toLowerCase();
                if (!validCategories.includes(category)) {
                    continue;
                }

                entries.push({
                    term: String(item.term).trim(),
                    category: category as DictionaryEntry['category'],
                    definition: item.definition ? String(item.definition).trim() : undefined,
                    aliases: Array.isArray(item.aliases)
                        ? item.aliases.map((a: unknown) => String(a).trim()).filter((a: string) => a)
                        : undefined
                });
            }

            return { success: true, entries };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to parse extraction response'
            };
        }
    }
}

describe('DictionaryService', () => {
    let service: MockDictionaryService;

    beforeEach(() => {
        service = new MockDictionaryService();
    });

    describe('createEmptyDictionary', () => {
        it('should create a dictionary with correct ID from name', () => {
            const dict = service.createEmptyDictionary('Acme Project Team');

            expect(dict.id).toBe('acme-project-team');
            expect(dict.name).toBe('Acme Project Team');
            expect(dict.entries).toHaveLength(0);
        });

        it('should handle special characters in name', () => {
            const dict = service.createEmptyDictionary('Test & Co. (2025)');

            expect(dict.id).toBe('test-co-2025');
        });

        it('should include description if provided', () => {
            const dict = service.createEmptyDictionary('My Dictionary', 'A helpful description');

            expect(dict.description).toBe('A helpful description');
        });

        it('should set timestamps', () => {
            const dict = service.createEmptyDictionary('Test');

            expect(dict.createdAt).toBeDefined();
            expect(dict.updatedAt).toBeDefined();
        });
    });

    describe('parseDictionaryContent', () => {
        it('should parse frontmatter metadata', () => {
            const content = `---
name: Test Dictionary
description: For testing
created: 2025-01-01T00:00:00Z
updated: 2025-01-24T00:00:00Z
---

## People

- **John Smith** - CEO
`;

            const dict = service.parseDictionaryContent(content, 'test-dict');

            expect(dict.name).toBe('Test Dictionary');
            expect(dict.description).toBe('For testing');
        });

        it('should parse people entries', () => {
            const content = `## People

- **John Smith** - CEO
- **Jane Doe** (JD) - Project Manager
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].term).toBe('John Smith');
            expect(dict.entries[0].category).toBe('person');
            expect(dict.entries[0].definition).toBe('CEO');
            expect(dict.entries[1].aliases).toContain('JD');
        });

        it('should parse acronym entries', () => {
            const content = `## Acronyms

- **API** - Application Programming Interface
- **KPI** - Key Performance Indicator
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].category).toBe('acronym');
            expect(dict.entries[0].term).toBe('API');
            expect(dict.entries[0].definition).toBe('Application Programming Interface');
        });

        it('should parse project entries', () => {
            const content = `## Projects

- **Phoenix** - Digital transformation initiative
- **Sunrise** (Phase 2) - Customer portal redesign
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].category).toBe('project');
        });

        it('should parse organization entries', () => {
            const content = `## Organizations

- **ACME Corp** - Main client
- **TechStart** (TS) - Vendor partner
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].category).toBe('organization');
        });

        it('should handle multiple categories in one file', () => {
            const content = `## People

- **John Smith** - CEO

## Acronyms

- **API** - Application Programming Interface

## Projects

- **Phoenix** - Main project
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(3);
            expect(dict.entries.filter(e => e.category === 'person')).toHaveLength(1);
            expect(dict.entries.filter(e => e.category === 'acronym')).toHaveLength(1);
            expect(dict.entries.filter(e => e.category === 'project')).toHaveLength(1);
        });

        it('should handle entries without definitions', () => {
            const content = `## People

- **John Smith**
- **Jane Doe** (JD)
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].definition).toBeUndefined();
        });

        it('should handle simple format without bold', () => {
            const content = `## Terms

- Sprint velocity - Measure of work per sprint
- Backlog grooming
`;

            const dict = service.parseDictionaryContent(content, 'test');

            expect(dict.entries).toHaveLength(2);
            expect(dict.entries[0].term).toBe('Sprint velocity');
            expect(dict.entries[0].definition).toBe('Measure of work per sprint');
        });
    });

    describe('generateDictionaryContent', () => {
        it('should generate valid markdown', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Test Dictionary',
                description: 'For testing',
                entries: [
                    { term: 'John Smith', category: 'person', definition: 'CEO' },
                    { term: 'API', category: 'acronym', definition: 'Application Programming Interface' }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const content = service.generateDictionaryContent(dict);

            expect(content).toContain('name: Test Dictionary');
            expect(content).toContain('description: For testing');
            expect(content).toContain('## People');
            expect(content).toContain('- **John Smith** - CEO');
            expect(content).toContain('## Acronyms');
            expect(content).toContain('- **API** - Application Programming Interface');
        });

        it('should include aliases in output', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Test',
                description: '',
                entries: [
                    { term: 'Jane Doe', category: 'person', aliases: ['JD', 'Jane'] }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const content = service.generateDictionaryContent(dict);

            expect(content).toContain('- **Jane Doe** (JD, Jane)');
        });

        it('should only include non-empty categories', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Test',
                description: '',
                entries: [
                    { term: 'Phoenix', category: 'project', definition: 'Main project' }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const content = service.generateDictionaryContent(dict);

            expect(content).toContain('## Projects');
            expect(content).not.toContain('## People');
            expect(content).not.toContain('## Acronyms');
        });
    });

    describe('formatForPrompt', () => {
        it('should format dictionary for LLM prompt', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Test Dictionary',
                description: '',
                entries: [
                    { term: 'John Smith', category: 'person', definition: 'CEO' },
                    { term: 'API', category: 'acronym', definition: 'Application Programming Interface' }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const prompt = service.formatForPrompt(dict);

            expect(prompt).toContain('<dictionary name="Test Dictionary">');
            expect(prompt).toContain('<persons>');
            expect(prompt).toContain('- John Smith: CEO');
            expect(prompt).toContain('</persons>');
            expect(prompt).toContain('<acronyms>');
            expect(prompt).toContain('- API: Application Programming Interface');
            expect(prompt).toContain('</acronyms>');
            expect(prompt).toContain('</dictionary>');
        });

        it('should return empty string for empty dictionary', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Empty',
                description: '',
                entries: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const prompt = service.formatForPrompt(dict);

            expect(prompt).toBe('');
        });

        it('should include aliases in prompt', () => {
            const dict: Dictionary = {
                id: 'test',
                name: 'Test',
                description: '',
                entries: [
                    { term: 'KPI', category: 'acronym', aliases: ['Key Perf Indicator'] }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const prompt = service.formatForPrompt(dict);

            expect(prompt).toContain('- KPI (Key Perf Indicator)');
        });
    });

    describe('parseExtractionResponse', () => {
        it('should parse valid JSON array', () => {
            const response = `[
                {"term": "John Smith", "category": "person", "definition": "CEO"},
                {"term": "API", "category": "acronym", "definition": "Application Programming Interface"}
            ]`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(2);
            expect(result.entries![0].term).toBe('John Smith');
            expect(result.entries![1].term).toBe('API');
        });

        it('should handle markdown code fences', () => {
            const response = `\`\`\`json
[
    {"term": "Test", "category": "term", "definition": "A test entry"}
]
\`\`\``;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(1);
        });

        it('should extract JSON from surrounding text', () => {
            const response = `Here are the extracted terms:

[
    {"term": "Phoenix", "category": "project", "definition": "Main initiative"}
]

Let me know if you need more.`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(1);
        });

        it('should skip entries with invalid categories', () => {
            const response = `[
                {"term": "Valid", "category": "person"},
                {"term": "Invalid", "category": "unknown"}
            ]`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(1);
            expect(result.entries![0].term).toBe('Valid');
        });

        it('should skip entries without required fields', () => {
            const response = `[
                {"term": "Valid", "category": "term"},
                {"term": "Missing category"},
                {"category": "term"}
            ]`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(1);
        });

        it('should handle aliases array', () => {
            const response = `[
                {"term": "KPI", "category": "acronym", "aliases": ["Key Performance Indicator", "Performance Metric"]}
            ]`;

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(true);
            expect(result.entries![0].aliases).toContain('Key Performance Indicator');
            expect(result.entries![0].aliases).toContain('Performance Metric');
        });

        it('should fail on invalid JSON', () => {
            const response = 'This is not JSON at all';

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('should fail when no array found', () => {
            const response = '{"term": "object not array", "category": "term"}';

            const result = service.parseExtractionResponse(response);

            expect(result.success).toBe(false);
        });
    });

    describe('Round-trip parsing', () => {
        it('should preserve data through generate and parse cycle', () => {
            const original: Dictionary = {
                id: 'test',
                name: 'Test Dictionary',
                description: 'A test description',
                entries: [
                    { term: 'John Smith', category: 'person', definition: 'CEO', aliases: ['JS'] },
                    { term: 'API', category: 'acronym', definition: 'Application Programming Interface' },
                    { term: 'Phoenix', category: 'project', definition: 'Main project' }
                ],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-24T00:00:00Z'
            };

            const content = service.generateDictionaryContent(original);
            const parsed = service.parseDictionaryContent(content, 'test');

            expect(parsed.name).toBe(original.name);
            expect(parsed.description).toBe(original.description);
            expect(parsed.entries).toHaveLength(original.entries.length);

            // Check each entry is preserved
            for (const originalEntry of original.entries) {
                const parsedEntry = parsed.entries.find(e => e.term === originalEntry.term);
                expect(parsedEntry).toBeDefined();
                expect(parsedEntry!.category).toBe(originalEntry.category);
                expect(parsedEntry!.definition).toBe(originalEntry.definition);
            }
        });
    });
});

describe('Dictionary Entry Categories', () => {
    it('should support all expected categories', () => {
        const validCategories: DictionaryEntry['category'][] = [
            'person',
            'acronym',
            'term',
            'project',
            'organization'
        ];

        // Verify each category is distinct
        expect(new Set(validCategories).size).toBe(validCategories.length);
    });
});

describe('Dictionary Deduplication', () => {
    it('should identify duplicate terms case-insensitively', () => {
        const entries: DictionaryEntry[] = [
            { term: 'John Smith', category: 'person' },
            { term: 'john smith', category: 'person' },
            { term: 'JOHN SMITH', category: 'person' }
        ];

        const existingTerms = new Set<string>();
        const deduplicated: DictionaryEntry[] = [];

        for (const entry of entries) {
            const key = entry.term.toLowerCase();
            if (!existingTerms.has(key)) {
                existingTerms.add(key);
                deduplicated.push(entry);
            }
        }

        expect(deduplicated).toHaveLength(1);
        expect(deduplicated[0].term).toBe('John Smith');
    });
});
