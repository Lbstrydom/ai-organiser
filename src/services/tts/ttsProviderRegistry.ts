/**
 * TTS provider registry.
 *
 * Maps provider names to engine factories so callers can build an engine
 * from a provider name + credentials without importing concrete classes.
 */

import { GeminiTtsEngine } from './ttsEngine';
import type { TtsEngine } from './ttsEngine';

type TtsEngineFactory = (apiKey: string, voice: string) => TtsEngine;

interface TtsProviderEntry {
    factory: TtsEngineFactory;
}

export const NARRATION_PROVIDERS: Record<string, TtsProviderEntry> = {
    gemini: {
        factory: (apiKey, voice) => new GeminiTtsEngine(apiKey, voice),
    },
};
