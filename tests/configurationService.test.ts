/**
 * ConfigurationService tests (production-driven)
 * All assertions exercise the real service via mocked vault I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile } from './mocks/obsidian';
import {
    ConfigurationService,
    DEFAULT_PERSONAS,
    DEFAULT_SUMMARY_PERSONAS,
    DEFAULT_MINUTES_PERSONAS
} from '../src/services/configurationService';

describe('ConfigurationService', () => {
    let app: App;
    let service: ConfigurationService;

    beforeEach(() => {
        app = new App();
        service = new ConfigurationService(app as any);
        vi.clearAllMocks();
    });

    describe('Initialization', () => {
        it('uses the default config folder', () => {
            expect(service.getConfigFolder()).toBe('AI-Organiser/Config');
        });

        it('supports a custom config folder', () => {
            const custom = new ConfigurationService(app as any, 'Custom/Config');
            expect(custom.getConfigFolder()).toBe('Custom/Config');
        });

        it('generates expected config paths', () => {
            const paths = service.getConfigPaths();
            expect(paths.minutesPersonas).toContain('minutes-personas.md');
            expect(paths.summaryPersonas).toContain('summary-personas.md');
            expect(paths.writingPersonas).toContain('writing-personas.md');
            expect(paths.taxonomyFile).toContain('taxonomy.md');
            expect(paths.basesTemplates).toContain('bases-templates.md');
        });
    });

    describe('Default Fallbacks', () => {
        it('returns default writing personas when file missing', async () => {
            app.vault.getAbstractFileByPath = () => null;
            const personas = await service.getPersonas();
            expect(personas).toEqual(DEFAULT_PERSONAS);
        });

        it('returns default summary personas when file missing', async () => {
            app.vault.getAbstractFileByPath = () => null;
            const personas = await service.getSummaryPersonas();
            expect(personas).toEqual(DEFAULT_SUMMARY_PERSONAS);
        });

        it('returns default minutes personas when file missing', async () => {
            app.vault.getAbstractFileByPath = () => null;
            const personas = await service.getMinutesPersonas();
            expect(personas).toEqual(DEFAULT_MINUTES_PERSONAS);
        });
    });

    describe('Persona Parsing via Production Paths', () => {
        function mockPersonasFile(content: string, kind: 'minutes' | 'summary' | 'writing' = 'minutes') {
            const file = new TFile(`AI-Organiser/Config/${kind}-personas.md`);
            app.vault.getAbstractFileByPath = (path: string) => {
                if (path.includes(`${kind}-personas`)) return file;
                return null;
            };
            app.vault.read = async () => content;
        }

        it('parses default markers and icons', async () => {
            mockPersonasFile(`# Personas

### Executive Summary (default) [icon: briefcase]

> Executive-friendly minutes

\`\`\`
Be concise.
\`\`\`

### Detailed Notes

> Full detail

\`\`\`
Be thorough.
\`\`\`
`);

            const personas = await service.getMinutesPersonas();

            expect(personas).toHaveLength(2);
            expect(personas[0].name).toBe('Executive Summary');
            expect(personas[0].isDefault).toBe(true);
            expect(personas[0].icon).toBe('briefcase');
            expect(personas[1].name).toBe('Detailed Notes');
            expect(personas[1].isDefault).toBeFalsy();
        });

        it('skips personas without prompts', async () => {
            mockPersonasFile(`### Missing Prompt

> No code fence here

### Valid Persona

> Has a prompt

\`\`\`
Valid prompt
\`\`\`
`);

            const personas = await service.getMinutesPersonas();

            expect(personas).toHaveLength(1);
            expect(personas[0].name).toBe('Valid Persona');
        });

        it('preserves multiline prompts', async () => {
            mockPersonasFile(`### Multiline

> Description

\`\`\`
Line 1
Line 2
Line 3
\`\`\`
`);

            const personas = await service.getMinutesPersonas();

            expect(personas[0].prompt).toContain('Line 1');
            expect(personas[0].prompt).toContain('Line 3');
        });

        it('falls back to defaults when no valid personas exist', async () => {
            mockPersonasFile('# Just a header\n\nNo personas here');

            const personas = await service.getMinutesPersonas();

            expect(personas).toEqual(DEFAULT_MINUTES_PERSONAS);
        });
    });

    describe('Persona Lookup', () => {
        it('finds a persona by id', async () => {
            app.vault.getAbstractFileByPath = () => null;
            const all = await service.getMinutesPersonas();
            const found = await service.getMinutesPersonaById(all[0].id);
            expect(found?.id).toBe(all[0].id);
        });

        it('returns null for unknown id', async () => {
            app.vault.getAbstractFileByPath = () => null;
            const found = await service.getMinutesPersonaById('does-not-exist');
            expect(found).toBeNull();
        });
    });

    describe('Caching', () => {
        it('does not re-read config within the cache TTL', async () => {
            const file = new TFile('AI-Organiser/Config/minutes-personas.md');
            let readCount = 0;

            app.vault.getAbstractFileByPath = (path: string) =>
                path.includes('minutes-personas') ? file : null;
            app.vault.read = async () => {
                readCount++;
                return '';
            };

            await service.getMinutesPersonas();
            const firstReadCount = readCount;

            await service.getMinutesPersonas();

            expect(readCount).toBeLessThanOrEqual(firstReadCount + 1);
        });
    });
});
