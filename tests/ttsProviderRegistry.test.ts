import { describe, it, expect } from 'vitest';
import { resolveGeminiTtsModel, NARRATION_PROVIDERS } from '../src/services/tts/ttsProviderRegistry';

describe('resolveGeminiTtsModel — auto-latest Gemini TTS model', () => {
    it('falls back to the pinned default when the live catalog is empty (offline/no key)', () => {
        // No live /models fetch has run in a unit test → getCachedModels returns null →
        // resolves against the known-previews static pool → newest = the 3.1 default.
        expect(resolveGeminiTtsModel()).toBe('gemini-3.1-flash-tts-preview');
    });

    it('the gemini provider exposes getEffectiveModelId so the engine + fingerprint stay in sync', () => {
        const gemini = NARRATION_PROVIDERS.gemini;
        expect(typeof gemini.getEffectiveModelId).toBe('function');
        expect(gemini.getEffectiveModelId!()).toBe('gemini-3.1-flash-tts-preview');
        // The static modelId is the same concrete default (display/fallback).
        expect(gemini.modelId).toBe('gemini-3.1-flash-tts-preview');
    });
});
