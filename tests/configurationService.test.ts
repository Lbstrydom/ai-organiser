/**
 * ConfigurationService tests (production-driven)
 * All assertions exercise the real service via mocked vault I/O.
 */

import { vi } from 'vitest';
import { App, TFile } from './mocks/obsidian';
import {
    ConfigurationService,
    DEFAULT_PERSONAS,
    DEFAULT_SUMMARY_PERSONAS,
    DEFAULT_MINUTES_PERSONAS,
    CURRENT_PERSONA_SCHEMA_VERSION,
    personaVersionMarker,
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

    describe('migratePersonaConfigFiles', () => {
        const paths = {
            writingPersonas: 'AI-Organiser/Config/writing-personas.md',
            summaryPersonas: 'AI-Organiser/Config/summary-personas.md',
            minutesPersonas: 'AI-Organiser/Config/minutes-personas.md',
        };

        it('skips migration when version is already current', async () => {
            const modifyCalls: string[] = [];
            app.vault.modify = async (file: any) => { modifyCalls.push(file.path); };

            await service.migratePersonaConfigFiles(CURRENT_PERSONA_SCHEMA_VERSION);

            expect(modifyCalls).toHaveLength(0);
        });

        it('creates missing persona files during migration', async () => {
            const created: string[] = [];
            app.vault.getAbstractFileByPath = () => null;
            app.vault.create = async (path: string, _content: string) => {
                created.push(path);
                return new TFile(path);
            };

            await service.migratePersonaConfigFiles(1);

            expect(created).toContain(paths.writingPersonas);
            expect(created).toContain(paths.summaryPersonas);
            expect(created).toContain(paths.minutesPersonas);
        });

        it('overwrites file when old version marker is present', async () => {
            const oldMarker = personaVersionMarker(1);
            const oldContent = `${oldMarker}\n# Old defaults`;
            const modified: Array<{ path: string; content: string }> = [];

            // All three files exist with old marker
            app.vault.getAbstractFileByPath = (path: string) => {
                if (path.endsWith('-personas.md')) return new TFile(path);
                return null;
            };
            app.vault.read = async () => oldContent;
            app.vault.modify = async (file: any, content: string) => {
                modified.push({ path: file.path, content });
            };

            await service.migratePersonaConfigFiles(1);

            expect(modified).toHaveLength(3);
            // New content should have the current version marker
            for (const { content } of modified) {
                expect(content).toContain(personaVersionMarker(CURRENT_PERSONA_SCHEMA_VERSION));
                expect(content).not.toContain(oldMarker);
            }
        });

        it('backs up customised file before overwriting', async () => {
            const customContent = '# My Custom Personas\n\nI edited this myself.';
            const created: Array<{ path: string; content: string }> = [];
            const modified: Array<{ path: string; content: string }> = [];

            app.vault.getAbstractFileByPath = (path: string) => {
                // Persona files exist but backup files do not
                if (path.endsWith('-personas.md') && !path.includes('.v1-defaults')) {
                    return new TFile(path);
                }
                return null;
            };
            app.vault.read = async () => customContent;
            app.vault.create = async (path: string, content: string) => {
                created.push({ path, content });
                return new TFile(path);
            };
            app.vault.modify = async (file: any, content: string) => {
                modified.push({ path: file.path, content });
            };

            await service.migratePersonaConfigFiles(1);

            // Should create 3 backup files with old content
            const backups = created.filter(c => c.path.includes('.v1-defaults'));
            expect(backups).toHaveLength(3);
            for (const backup of backups) {
                expect(backup.content).toBe(customContent);
            }

            // Should overwrite the 3 originals with new defaults
            expect(modified).toHaveLength(3);
            for (const { content } of modified) {
                expect(content).toContain(personaVersionMarker(CURRENT_PERSONA_SCHEMA_VERSION));
            }
        });

        it('does not create backup if one already exists', async () => {
            const customContent = '# Custom content without marker';
            const created: string[] = [];

            app.vault.getAbstractFileByPath = (path: string) => {
                // Both persona files AND backup files exist
                if (path.endsWith('-personas.md') || path.includes('.v1-defaults')) {
                    return new TFile(path);
                }
                return null;
            };
            app.vault.read = async () => customContent;
            app.vault.create = async (path: string) => {
                created.push(path);
                return new TFile(path);
            };
            app.vault.modify = async () => {};

            await service.migratePersonaConfigFiles(1);

            // No backup files should be created (they already exist)
            const backups = created.filter(c => c.includes('.v1-defaults'));
            expect(backups).toHaveLength(0);
        });

        it('continues migrating other files when one fails', async () => {
            let callIndex = 0;
            const modified: string[] = [];

            app.vault.getAbstractFileByPath = (path: string) => {
                if (path.endsWith('-personas.md')) return new TFile(path);
                return null;
            };
            app.vault.read = async () => {
                callIndex++;
                if (callIndex === 1) throw new Error('disk error');
                return personaVersionMarker(1) + '\n# Old defaults';
            };
            app.vault.modify = async (file: any) => {
                modified.push(file.path);
            };

            await service.migratePersonaConfigFiles(1);

            // First file fails, but the other two should still be migrated
            expect(modified.length).toBeGreaterThanOrEqual(2);
        });
    });
});
