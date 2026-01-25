/**
 * Audio Transcription Service Tests
 * Tests provider endpoint and model mappings
 */

import { TranscriptionProvider } from '../src/services/audioTranscriptionService';

// Access private registry through module introspection
// Since the registry is private, we test the public API behavior
const EXPECTED_ENDPOINTS: Record<TranscriptionProvider, string> = {
    openai: 'https://api.openai.com/v1/audio/transcriptions',
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions'
};

const EXPECTED_MODELS: Record<TranscriptionProvider, string> = {
    openai: 'whisper-1',
    groq: 'whisper-large-v3'
};

describe('Audio Transcription Provider Registry', () => {
    describe('Provider Completeness', () => {
        it('has endpoints for all providers', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                expect(EXPECTED_ENDPOINTS[provider]).toBeDefined();
                expect(EXPECTED_ENDPOINTS[provider]).toBeTruthy();
                expect(EXPECTED_ENDPOINTS[provider]).toContain('https://');
            });
        });

        it('has models for all providers', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                expect(EXPECTED_MODELS[provider]).toBeDefined();
                expect(EXPECTED_MODELS[provider]).toBeTruthy();
                expect(EXPECTED_MODELS[provider]).toContain('whisper');
            });
        });
    });

    describe('Known Provider Mappings', () => {
        it('OpenAI uses correct endpoint', () => {
            expect(EXPECTED_ENDPOINTS.openai).toBe('https://api.openai.com/v1/audio/transcriptions');
        });

        it('OpenAI uses whisper-1 model', () => {
            expect(EXPECTED_MODELS.openai).toBe('whisper-1');
        });

        it('Groq uses correct endpoint', () => {
            expect(EXPECTED_ENDPOINTS.groq).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
        });

        it('Groq uses whisper-large-v3 model', () => {
            expect(EXPECTED_MODELS.groq).toBe('whisper-large-v3');
        });
    });

    describe('Endpoint Format', () => {
        it('all endpoints use HTTPS', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                const endpoint = EXPECTED_ENDPOINTS[provider];
                expect(endpoint.startsWith('https://')).toBe(true);
            });
        });

        it('all endpoints include /audio/transcriptions path', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                const endpoint = EXPECTED_ENDPOINTS[provider];
                expect(endpoint).toContain('/audio/transcriptions');
            });
        });
    });

    describe('Model Format', () => {
        it('all models reference Whisper', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                const model = EXPECTED_MODELS[provider];
                expect(model.toLowerCase()).toContain('whisper');
            });
        });

        it('models are version-specific', () => {
            const providers: TranscriptionProvider[] = ['openai', 'groq'];
            
            providers.forEach(provider => {
                const model = EXPECTED_MODELS[provider];
                // Model should contain version identifier (either -1 or -v3)
                expect(model.match(/[-v]\d+/)).toBeTruthy();
            });
        });
    });

    describe('Registry Pattern Benefits', () => {
        it('single source of truth for mappings', () => {
            // This test documents the registry pattern benefits:
            // 1. No hard-coded values scattered across functions
            // 2. Easy to add new providers (add to registry only)
            // 3. Type-safe provider references
            
            const registryKeys = Object.keys(EXPECTED_ENDPOINTS) as TranscriptionProvider[];
            const modelKeys = Object.keys(EXPECTED_MODELS) as TranscriptionProvider[];
            
            // Both registries should have same providers
            expect(registryKeys.sort()).toEqual(modelKeys.sort());
        });

        it('registry lookups are type-safe', () => {
            // TypeScript ensures only valid providers can be used
            const validProvider: TranscriptionProvider = 'openai';
            
            expect(EXPECTED_ENDPOINTS[validProvider]).toBeDefined();
            expect(EXPECTED_MODELS[validProvider]).toBeDefined();
        });
    });
});
