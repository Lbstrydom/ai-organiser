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

    describe('retired minutes persona migration', () => {
        it('should migrate corporate-minutes to standard', () => {
            const old = { minutesDefaultPersona: 'corporate-minutes' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should migrate action-register-only to standard', () => {
            const old = { minutesDefaultPersona: 'action-register-only' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should migrate client-mom-short to standard', () => {
            const old = { minutesDefaultPersona: 'client-mom-short' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should migrate technical-review to standard', () => {
            const old = { minutesDefaultPersona: 'technical-review' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should migrate board-governance to governance', () => {
            const old = { minutesDefaultPersona: 'board-governance' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('governance');
        });

        it('should not change already-valid minutes persona', () => {
            const old = { minutesDefaultPersona: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should not change custom minutes persona IDs', () => {
            const old = { minutesDefaultPersona: 'my-custom-persona' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesDefaultPersona).toBe('my-custom-persona');
        });
    });
});
