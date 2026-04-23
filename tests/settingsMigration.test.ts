/**
 * Settings Migration Tests
 * Tests for the migrateOldSettings() pure function
 */

import { migrateOldSettings, DEFAULT_SETTINGS } from '../src/core/settings';

describe('migrateOldSettings', () => {
    it('should return null for null input', () => {
        expect(migrateOldSettings(null)).toBeNull();
    });

    it('should migrate ollama serviceType to local', () => {
        const old = {
            serviceType: 'ollama',
            ollamaEndpoint: 'http://localhost:11434',
            ollamaModel: 'llama3'
        };
        const result = migrateOldSettings(old)!;
        expect(result.serviceType).toBe('local');
        expect(result.localEndpoint).toBe('http://localhost:11434');
        expect(result.localModel).toBe('llama3');
        expect(result.ollamaEndpoint).toBeUndefined();
        expect(result.ollamaModel).toBeUndefined();
    });

    it('should migrate old tag range settings to maxTags', () => {
        const old = { tagRangeGenerateMax: 8 } as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(8);
    });

    it('should use default maxTags when no range settings exist', () => {
        const old = {} as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(DEFAULT_SETTINGS.maxTags);
    });

    it('should not overwrite existing maxTags', () => {
        const old = { maxTags: 10, tagRangeGenerateMax: 8 } as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(10);
    });

    it('should migrate old student summary persona to brief', () => {
        const old = { defaultSummaryPersona: 'student' } as any;
        const result = migrateOldSettings(old)!;
        expect(result.defaultSummaryPersona).toBe('brief');
    });

    it('should not change already-migrated summary persona', () => {
        const old = { defaultSummaryPersona: 'brief' } as any;
        const result = migrateOldSettings(old)!;
        expect(result.defaultSummaryPersona).toBe('brief');
    });

    describe('summary length migration', () => {
        it('should migrate comprehensive to detailed', () => {
            const old = { summaryLength: 'comprehensive' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('detailed');
        });

        it('should migrate detailed to standard', () => {
            const old = { summaryLength: 'detailed' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('standard');
        });

        it('should not change brief', () => {
            const old = { summaryLength: 'brief' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('brief');
        });

        it('should not change already-migrated standard', () => {
            const old = { summaryLength: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('standard');
        });

        it('should not double-migrate comprehensive (comprehensive→detailed, not →standard)', () => {
            const old = { summaryLength: 'comprehensive' } as any;
            const result = migrateOldSettings(old)!;
            // comprehensive should become detailed, NOT standard
            expect(result.summaryLength).toBe('detailed');
        });
    });

    describe('sketch output folder migration', () => {
        it('should migrate legacy full path to subfolder', () => {
            const old = { sketchOutputFolder: 'AI-Organiser/Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('Sketches');
        });

        it('should not change already-migrated sketch folder', () => {
            const old = { sketchOutputFolder: 'Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('Sketches');
        });

        it('should not change custom sketch folder', () => {
            const old = { sketchOutputFolder: 'My Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('My Sketches');
        });
    });

    describe('minutes persona/detailLevel → minutesStyle migration', () => {
        it('should migrate governance persona to detailed style', () => {
            const old = { minutesDefaultPersona: 'governance', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
            expect(result.minutesDefaultPersona).toBeUndefined();
            expect(result.minutesDetailLevel).toBeUndefined();
        });

        it('should migrate concise detail to smart-brevity style', () => {
            const old = { minutesDefaultPersona: 'standard', minutesDetailLevel: 'concise' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('smart-brevity');
        });

        it('should migrate template detail to guided style', () => {
            const old = { minutesDetailLevel: 'template' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('guided');
        });

        it('should migrate standard persona + standard detail to standard style', () => {
            const old = { minutesDefaultPersona: 'standard', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('standard');
        });

        it('should migrate custom persona to standard style', () => {
            const old = { minutesDefaultPersona: 'my-custom-persona', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('standard');
        });

        it('should not migrate if minutesStyle already set', () => {
            const old = { minutesStyle: 'detailed', minutesDefaultPersona: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
            // Old key preserved because migration block was skipped
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should handle missing persona with detail only', () => {
            const old = { minutesDetailLevel: 'detailed' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
        });

        it('should handle missing detail with persona only', () => {
            const old = { minutesDefaultPersona: 'governance' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
        });
    });

    describe('audit settings defaults', () => {
        it('should have enableLLMAudit default to false', () => {
            expect(DEFAULT_SETTINGS.enableLLMAudit).toBe(false);
        });

        it('should have auditProvider default to main', () => {
            expect(DEFAULT_SETTINGS.auditProvider).toBe('main');
        });

        it('should have auditModel default to empty string', () => {
            expect(DEFAULT_SETTINGS.auditModel).toBe('');
        });

        it('should preserve existing audit settings during migration', () => {
            const old = {
                enableLLMAudit: true,
                auditProvider: 'claude',
                auditModel: 'claude-opus-4-6'
            } as any;
            const result = migrateOldSettings(old)!;
            expect(result.enableLLMAudit).toBe(true);
            expect(result.auditProvider).toBe('claude');
            expect(result.auditModel).toBe('claude-opus-4-6');
        });

        it('should not add audit settings if not present (handled by DEFAULT_SETTINGS merge)', () => {
            const old = {} as any;
            const result = migrateOldSettings(old)!;
            // migrateOldSettings doesn't add missing keys — that's done by {...DEFAULT_SETTINGS, ...loaded}
            expect(result.enableLLMAudit).toBeUndefined();
        });
    });

    describe('Gemini deprecated-id → latest-* sentinel migration', () => {
        it('migrates gemini-3-pro-preview → latest-pro (discontinued March 2026)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-pro-preview', pdfModel: 'gemini-3-pro-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-pro');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('migrates gemini-3-flash → latest-flash (never existed on Google API)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-flash', pdfModel: 'gemini-3-flash' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
            expect(result.pdfModel).toBe('latest-flash');
        });

        it('migrates gemini-3.1-pro → latest-pro (never existed on Google API)', () => {
            const old = { youtubeGeminiModel: 'gemini-3.1-pro', pdfModel: 'gemini-3.1-pro' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-pro');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('migrates gemini-2.0-flash → latest-flash (deprecated)', () => {
            const old = { youtubeGeminiModel: 'gemini-2.0-flash' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
        });

        it('migrates gemini-2.0-flash-lite → latest-flash (deprecated)', () => {
            const old = { pdfModel: 'gemini-2.0-flash-lite' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pdfModel).toBe('latest-flash');
        });

        it('leaves gemini-3.1-pro-preview unchanged (valid Google preview ID)', () => {
            const old = { youtubeGeminiModel: 'gemini-3.1-pro-preview', pdfModel: 'gemini-3.1-pro-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('gemini-3.1-pro-preview');
            expect(result.pdfModel).toBe('gemini-3.1-pro-preview');
        });

        it('leaves gemini-3-flash-preview unchanged (valid Google preview ID)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-flash-preview', pdfModel: 'gemini-3-flash-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('gemini-3-flash-preview');
            expect(result.pdfModel).toBe('gemini-3-flash-preview');
        });

        it('leaves already-sentinel values unchanged', () => {
            const old = { youtubeGeminiModel: 'latest-flash', pdfModel: 'latest-pro' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('should not change empty pdfModel', () => {
            const old = { pdfModel: '' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pdfModel).toBe('');
        });
    });

});
