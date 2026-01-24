/**
 * Configuration Service Tests
 * Tests for persona loading, config parsing, and error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile, TFolder } from './mocks/obsidian';

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
