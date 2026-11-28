/** Migration runs on every load: a value the user chose must survive it. */
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_SETTINGS, getAudioNarrationFullPath, getPluginManagedFolders, getTranscriptOutputFullPath,
    migrateOldSettings, type AIOrganiserSettings,
} from '../src/core/settings';

type Stored = Record<string, any>;
const load = (stored: Stored): Stored => migrateOldSettings(structuredClone(stored))!;

describe('summary length', () => {
    for (const chosen of ['brief', 'standard', 'detailed']) {
        it(`keeps a chosen "${chosen}" across loads`, () => {
            expect(load(load({ summaryLength: chosen })).summaryLength).toBe(chosen);
        });
    }

    it('still converts the retired "comprehensive", and stays converted', () => {
        expect(load(load({ summaryLength: 'comprehensive' })).summaryLength).toBe('detailed');
    });
});

describe('visual embedding dimension', () => {
    it('stores a numeric string as the same number', () => {
        expect(load({ visualEmbeddingDim: '1024' }).visualEmbeddingDim).toBe(1024);
    });

    it('replaces an unusable value with the default', () => {
        expect(load({ visualEmbeddingDim: 'wide' }).visualEmbeddingDim).toBe(DEFAULT_SETTINGS.visualEmbeddingDim);
    });
});

describe('managed folders under a split output root', () => {
    const settings: AIOrganiserSettings = {
        ...structuredClone(DEFAULT_SETTINGS), outputRootFolder: 'Outputs',
        transcriptOutputFolder: 'Spoken', audioNarrationOutputFolder: 'Read',
    };

    it('includes the transcript-only and narration folders', () => {
        const managed = getPluginManagedFolders(settings);
        expect(managed).toContain(getTranscriptOutputFullPath(settings));
        expect(managed).toContain(getAudioNarrationFullPath(settings));
        expect(new Set(managed).size).toBe(managed.length);
    });
});
