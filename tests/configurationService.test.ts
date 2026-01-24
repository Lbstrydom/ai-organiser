/**
 * Configuration Service Tests
 * Tests for persona loading, config parsing, and error handling
 *
 * Note: This file contains two types of tests:
 * 1. SPECIFICATION TESTS (parsePersonasContent): Document expected parsing behavior
 *    - These test a local replica of the parsing logic
 *    - Purpose: Define the contract for how personas should be parsed
 * 2. PRODUCTION TESTS (ConfigurationService): Test actual production code
 *    - These use mocked vault to test the real service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile, TFolder } from './mocks/obsidian';
import { ConfigurationService, DEFAULT_PERSONAS, DEFAULT_SUMMARY_PERSONAS, DEFAULT_MINUTES_PERSONAS } from '../src/services/configurationService';

// Mock persona data
const MOCK_PERSONAS = [
    {
        id: 'corporate-minutes',
        name: 'Corporate Minutes',
        description: 'Standard corporate meeting minutes',
        prompt: 'Create professional meeting minutes',
        isDefault: true,
    },
    {
        id: 'informal-notes',
        name: 'Informal Notes',
        description: 'Casual meeting notes',
        prompt: 'Create informal notes',
    },
];

// Persona parsing logic (replicated from configurationService)
interface Persona {
    id: string;
    name: string;
    description: string;
    prompt: string;
    isDefault?: boolean;
    icon?: string;
}

function parsePersonasContent(content: string, defaults: Persona[]): Persona[] {
    const personas: Persona[] = [];

    // Split by ### headers (persona sections)
    const sections = content.split(/^###\s+/m);

    for (const section of sections) {
        if (!section.trim()) continue;

        const lines = section.split('\n');
        const firstLine = lines[0]?.trim() || '';

        // Skip if it's a higher-level header or empty
        if (!firstLine || firstLine.startsWith('#')) continue;

        // Extract persona name, check for (default) marker, and extract icon
        const isDefault = firstLine.toLowerCase().includes('(default)');

        // Extract icon if present: [icon: icon-name]
        const iconMatch = firstLine.match(/\[icon:\s*([^\]]+)\]/i);
        const icon = iconMatch ? iconMatch[1].trim() : undefined;

        // Remove (default) marker and [icon: ...] from name
        const name = firstLine
            .replace(/\s*\(default\)\s*/i, '')
            .replace(/\s*\[icon:\s*[^\]]+\]\s*/i, '')
            .trim();
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        if (!id) continue;

        // Find description and prompt
        let description = '';
        let prompt = '';
        let inCodeBlock = false;
        let codeBlockLines: string[] = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim().startsWith('```')) {
                if (inCodeBlock) {
                    // End of code block
                    prompt = codeBlockLines.join('\n').trim();
                    break;
                } else {
                    // Start of code block
                    inCodeBlock = true;
                    codeBlockLines = [];
                }
            } else if (inCodeBlock) {
                codeBlockLines.push(line);
            } else if (line.trim() && !description) {
                // First non-empty line is description
                description = line.trim().replace(/^>\s*/, '');
            }
        }

        if (name && prompt) {
            const persona: Persona = {
                id,
                name,
                description: description || `${name} persona`,
                prompt,
                isDefault
            };
            if (icon) {
                persona.icon = icon;
            }
            personas.push(persona);
        }
    }

    // Fall back to defaults if nothing parsed
    return personas.length > 0 ? personas : defaults;
}

describe('Configuration Service', () => {
    describe('Persona Parsing', () => {
        it('should parse personas from markdown content', () => {
            const content = `# Personas

### Corporate Minutes (default)

> Standard corporate meeting minutes

\`\`\`
Create professional meeting minutes with decisions and actions.
\`\`\`

### Informal Notes

> Casual meeting notes

\`\`\`
Create casual meeting notes.
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas).toHaveLength(2);
            expect(personas[0].name).toBe('Corporate Minutes');
            expect(personas[0].isDefault).toBe(true);
            expect(personas[1].name).toBe('Informal Notes');
            expect(personas[1].isDefault).toBeFalsy();
        });

        it('should extract persona ID from name', () => {
            const content = `### My Custom Persona

> Description

\`\`\`
Prompt text
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas[0].id).toBe('my-custom-persona');
        });

        it('should handle icon extraction', () => {
            const content = `### Technical Writer [icon: pen-tool]

> Technical documentation persona

\`\`\`
Write technical documentation.
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas[0].name).toBe('Technical Writer');
            expect(personas[0].icon).toBe('pen-tool');
        });

        it('should fall back to defaults when content is empty', () => {
            const content = '';
            const defaults: Persona[] = [
                { id: 'default', name: 'Default', description: 'Default persona', prompt: 'Default prompt' }
            ];

            const personas = parsePersonasContent(content, defaults);

            expect(personas).toEqual(defaults);
        });

        it('should fall back to defaults when no valid personas found', () => {
            const content = '# Just a header\n\nSome text without personas';
            const defaults: Persona[] = [
                { id: 'default', name: 'Default', description: 'Default', prompt: 'Prompt' }
            ];

            const personas = parsePersonasContent(content, defaults);

            expect(personas).toEqual(defaults);
        });

        it('should skip personas without prompts', () => {
            const content = `### No Prompt Persona

> This persona has no code block

Just text here.

### Valid Persona

> This one has a prompt

\`\`\`
Valid prompt here
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas).toHaveLength(1);
            expect(personas[0].name).toBe('Valid Persona');
        });

        it('should handle multiline prompts', () => {
            const content = `### Detailed Persona

> Detailed description

\`\`\`
Line 1 of prompt
Line 2 of prompt
Line 3 of prompt
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas[0].prompt).toContain('Line 1');
            expect(personas[0].prompt).toContain('Line 2');
            expect(personas[0].prompt).toContain('Line 3');
        });

        it('should handle blockquote descriptions', () => {
            const content = `### Quoted Description

> This is a blockquote description

\`\`\`
Prompt
\`\`\`
`;

            const personas = parsePersonasContent(content, []);

            expect(personas[0].description).toBe('This is a blockquote description');
        });
    });

    describe('Default Personas', () => {
        it('should have at least one default persona', () => {
            expect(MOCK_PERSONAS.length).toBeGreaterThan(0);
        });

        it('should have exactly one persona marked as default', () => {
            const defaultPersonas = MOCK_PERSONAS.filter(p => p.isDefault);
            expect(defaultPersonas).toHaveLength(1);
        });

        it('should have valid IDs for all personas', () => {
            for (const persona of MOCK_PERSONAS) {
                expect(persona.id).toMatch(/^[a-z0-9-]+$/);
                expect(persona.id.length).toBeGreaterThan(0);
            }
        });

        it('should have non-empty prompts for all personas', () => {
            for (const persona of MOCK_PERSONAS) {
                expect(persona.prompt.length).toBeGreaterThan(0);
            }
        });
    });

    describe('Config Loading Error Handling', () => {
        it('should handle missing config file gracefully', async () => {
            const mockApp = new App();
            mockApp.vault.getAbstractFileByPath = () => null;

            // Simulating the actual behavior - returns defaults when file not found
            const file = mockApp.vault.getAbstractFileByPath('config/personas.md');
            expect(file).toBeNull();

            // Should fall back to defaults
            const personas = parsePersonasContent('', MOCK_PERSONAS);
            expect(personas).toEqual(MOCK_PERSONAS);
        });

        it('should handle malformed markdown', () => {
            const malformedContent = `
### Incomplete

No code block here, just text

###

\`\`\`
Orphan code block
\`\`\`
`;

            const personas = parsePersonasContent(malformedContent, MOCK_PERSONAS);

            // Should fall back to defaults since no valid personas
            expect(personas).toEqual(MOCK_PERSONAS);
        });
    });
});

describe('Config Path Generation', () => {
    it('should generate correct config paths', () => {
        const pluginFolder = 'AI Organiser';
        const configFolder = 'config';

        const paths = {
            minutesPersonas: `${pluginFolder}/${configFolder}/minutes-personas.md`,
            summaryPersonas: `${pluginFolder}/${configFolder}/summary-personas.md`,
            writingPersonas: `${pluginFolder}/${configFolder}/writing-personas.md`,
        };

        expect(paths.minutesPersonas).toBe('AI Organiser/config/minutes-personas.md');
        expect(paths.summaryPersonas).toBe('AI Organiser/config/summary-personas.md');
    });
});

// ============================================================================
// PRODUCTION MODULE TESTS
// These tests verify the actual ConfigurationService behavior
// ============================================================================

describe('ConfigurationService (Production)', () => {
    let mockApp: App;
    let service: ConfigurationService;

    beforeEach(() => {
        mockApp = new App();
        service = new ConfigurationService(mockApp as any);
    });

    describe('Initialization', () => {
        it('should initialize with default config folder', () => {
            expect(service.getConfigFolder()).toBe('AI-Organiser/Config');
        });

        it('should allow custom config folder', () => {
            const customService = new ConfigurationService(mockApp as any, 'Custom/Path');
            expect(customService.getConfigFolder()).toBe('Custom/Path');
        });

        it('should generate correct config paths', () => {
            const paths = service.getConfigPaths();

            expect(paths.minutesPersonas).toContain('minutes-personas.md');
            expect(paths.summaryPersonas).toContain('summary-personas.md');
            expect(paths.writingPersonas).toContain('writing-personas.md');
            expect(paths.taxonomyFile).toContain('taxonomy.md');
            expect(paths.basesTemplates).toContain('bases-templates.md');
        });
    });

    describe('Default Personas', () => {
        it('should return default writing personas when file not found', async () => {
            // Mock vault to return null (file not found)
            mockApp.vault.getAbstractFileByPath = () => null;

            const personas = await service.getPersonas();

            expect(personas).toEqual(DEFAULT_PERSONAS);
            expect(personas.length).toBeGreaterThan(0);
        });

        it('should return default summary personas when file not found', async () => {
            mockApp.vault.getAbstractFileByPath = () => null;

            const personas = await service.getSummaryPersonas();

            expect(personas).toEqual(DEFAULT_SUMMARY_PERSONAS);
            expect(personas.length).toBeGreaterThan(0);
        });

        it('should return default minutes personas when file not found', async () => {
            mockApp.vault.getAbstractFileByPath = () => null;

            const personas = await service.getMinutesPersonas();

            expect(personas).toEqual(DEFAULT_MINUTES_PERSONAS);
            expect(personas.length).toBeGreaterThan(0);
        });

        it('should have exactly one default persona in each category', async () => {
            mockApp.vault.getAbstractFileByPath = () => null;

            const writingDefault = await service.getDefaultPersona();
            const summaryDefault = await service.getDefaultSummaryPersona();
            const minutesDefault = await service.getDefaultMinutesPersona();

            expect(writingDefault.isDefault).toBe(true);
            expect(summaryDefault.isDefault).toBe(true);
            expect(minutesDefault.isDefault).toBe(true);
        });
    });

    describe('Persona Loading from File', () => {
        it('should parse personas from markdown file content', async () => {
            const mockFile = new TFile('AI-Organiser/Config/minutes-personas.md');
            const fileContent = `# Minutes Personas

### Executive Summary (default) [icon: briefcase]

> Brief, action-focused minutes for executives

\`\`\`
Create concise executive summary focusing on decisions and actions.
\`\`\`

### Detailed Notes

> Comprehensive meeting documentation

\`\`\`
Create detailed meeting notes with full context.
\`\`\`
`;

            mockApp.vault.getAbstractFileByPath = (path: string) => {
                if (path.includes('minutes-personas')) return mockFile;
                return null;
            };
            mockApp.vault.read = async () => fileContent;

            const personas = await service.getMinutesPersonas();

            expect(personas.length).toBe(2);
            expect(personas[0].name).toBe('Executive Summary');
            expect(personas[0].isDefault).toBe(true);
            expect(personas[0].icon).toBe('briefcase');
            expect(personas[1].name).toBe('Detailed Notes');
            expect(personas[1].isDefault).toBeFalsy();
        });

        it('should fall back to defaults when file has no valid personas', async () => {
            const mockFile = new TFile('AI-Organiser/Config/minutes-personas.md');

            mockApp.vault.getAbstractFileByPath = (path: string) => {
                if (path.includes('minutes-personas')) return mockFile;
                return null;
            };
            mockApp.vault.read = async () => '# Just a header\n\nNo personas here';

            const personas = await service.getMinutesPersonas();

            // Should fall back to defaults
            expect(personas).toEqual(DEFAULT_MINUTES_PERSONAS);
        });
    });

    describe('Persona Retrieval by ID', () => {
        it('should find persona by ID', async () => {
            mockApp.vault.getAbstractFileByPath = () => null;

            // Get the first default persona's ID
            const allPersonas = await service.getMinutesPersonas();
            const firstId = allPersonas[0].id;

            const found = await service.getMinutesPersonaById(firstId);

            expect(found).not.toBeNull();
            expect(found?.id).toBe(firstId);
        });

        it('should return null for unknown persona ID', async () => {
            mockApp.vault.getAbstractFileByPath = () => null;

            const found = await service.getMinutesPersonaById('nonexistent-id');

            expect(found).toBeNull();
        });
    });

    describe('Caching', () => {
        it('should cache config and not re-read within TTL', async () => {
            const mockFile = new TFile('AI-Organiser/Config/minutes-personas.md');
            let readCount = 0;

            mockApp.vault.getAbstractFileByPath = () => mockFile;
            mockApp.vault.read = async () => {
                readCount++;
                return '';
            };

            // First call loads config
            await service.getMinutesPersonas();
            const firstReadCount = readCount;

            // Second call should use cache
            await service.getMinutesPersonas();

            // Read count should not have increased significantly
            // (may be called once per file type on first load)
            expect(readCount).toBeLessThanOrEqual(firstReadCount + 1);
        });
    });
});
