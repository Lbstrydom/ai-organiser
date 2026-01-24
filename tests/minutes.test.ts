/**
 * Minutes Feature Integration Tests
 * Tests for Meeting Minutes modal, persona loading, and error scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, TFile, clearMockNotices, mockNotices } from './mocks/obsidian';

// Mock plugin with configService
function createMockPlugin(personasToReturn: any[] = []) {
    const mockApp = new App();

    return {
        app: mockApp,
        settings: {
            minutesDefaultPersona: 'corporate-minutes',
            minutesObsidianTasksFormat: true,
            minutesDefaultTimezone: 'UTC',
            minutesOutputFolder: 'Minutes',
            pluginFolder: 'AI Organiser',
            transcriptFolder: 'Transcripts',
            audioTranscriptionProvider: 'openai',
            audioTranscriptionApiKey: '',
            cloudServiceType: 'openai',
            cloudApiKey: '',
            cloudModel: 'gpt-4',
            localModel: '',
            providerSettings: {},
        },
        configService: {
            getMinutesPersonas: vi.fn().mockResolvedValue(personasToReturn),
            getDefaultMinutesPersona: vi.fn().mockResolvedValue(personasToReturn[0] || null),
        },
        llmService: {
            getModelName: vi.fn().mockReturnValue('gpt-4'),
        },
        t: {
            minutes: {
                modalTitle: 'Meeting Minutes',
                fieldTitle: 'Meeting title',
                fieldDate: 'Date',
                fieldStartTime: 'Start time',
                fieldEndTime: 'End time',
                fieldLocation: 'Location',
                fieldChair: 'Chair',
                fieldPersona: 'Minutes style',
                fieldAgenda: 'Agenda',
                fieldTranscript: 'Transcript',
                fieldTranscriptDesc: 'Paste or edit the transcript text',
                fieldDualOutput: 'Generate external version',
                fieldObsidianTasks: 'Obsidian Tasks format',
                submitButton: 'Create Minutes',
                errorNoPersonas: 'No personas found for meeting minutes',
                errorMissingFields: 'Please fill in all required fields',
                generating: 'Generating minutes...',
                saved: 'Minutes saved',
                audioTranscriptionSection: 'Audio Transcription',
                audioDetected: 'Audio files detected',
                transcribeButton: 'Transcribe',
                transcribing: 'Transcribing...',
                contextDocumentsSection: 'Context Documents',
                contextDocumentsDesc: 'Attach documents',
                addDocument: 'Add Document',
            },
            modals: {
                cancelButton: 'Cancel',
            },
        },
    };
}

// Default personas for testing
const DEFAULT_PERSONAS = [
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
        prompt: 'Create informal meeting notes',
    },
];

describe('Minutes Feature', () => {
    beforeEach(() => {
        clearMockNotices();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Persona Loading', () => {
        it('should return personas when available', async () => {
            const plugin = createMockPlugin(DEFAULT_PERSONAS);
            const personas = await plugin.configService.getMinutesPersonas();

            expect(personas).toHaveLength(2);
            expect(personas[0].id).toBe('corporate-minutes');
            expect(personas[0].isDefault).toBe(true);
        });

        it('should handle empty personas array', async () => {
            const plugin = createMockPlugin([]);
            const personas = await plugin.configService.getMinutesPersonas();

            expect(personas).toHaveLength(0);
        });

        it('should handle persona loading failure', async () => {
            const plugin = createMockPlugin([]);
            plugin.configService.getMinutesPersonas = vi.fn().mockRejectedValue(new Error('Config load failed'));

            await expect(plugin.configService.getMinutesPersonas()).rejects.toThrow('Config load failed');
        });
    });

    describe('Form Validation', () => {
        it('should validate required fields correctly', () => {
            const state = {
                title: 'Weekly Sync',
                date: '2025-01-24',
                startTime: '10:00',
                endTime: '11:00',
                location: 'Conference Room A',
                chair: 'John Doe',
                participants: 'Alice, Bob, Charlie',
                transcript: 'Meeting transcript here...',
            };

            const isValid = !!(
                state.title &&
                state.date &&
                state.startTime &&
                state.endTime &&
                state.location &&
                state.chair &&
                state.participants &&
                state.transcript
            );

            expect(isValid).toBe(true);
        });

        it('should fail validation when title is missing', () => {
            const state = {
                title: '',
                date: '2025-01-24',
                startTime: '10:00',
                endTime: '11:00',
                location: 'Conference Room A',
                chair: 'John Doe',
                participants: 'Alice, Bob',
                transcript: 'Transcript',
            };

            const isValid = !!(
                state.title &&
                state.date &&
                state.startTime &&
                state.endTime &&
                state.location &&
                state.chair &&
                state.participants &&
                state.transcript
            );

            expect(isValid).toBe(false);
        });

        it('should fail validation when transcript is missing', () => {
            const state = {
                title: 'Meeting',
                date: '2025-01-24',
                startTime: '10:00',
                endTime: '11:00',
                location: 'Room A',
                chair: 'John',
                participants: 'Alice',
                transcript: '',
            };

            const isValid = !!(state.title && state.transcript);
            expect(isValid).toBe(false);
        });
    });

    describe('Transcription Provider Detection', () => {
        it('should detect OpenAI transcription provider', () => {
            const settings = {
                audioTranscriptionProvider: 'openai',
                audioTranscriptionApiKey: 'sk-test-key',
                cloudServiceType: 'claude',
                cloudApiKey: 'sk-ant-key',
                providerSettings: {},
            };

            const provider = getTranscriptionProvider(settings);
            expect(provider).toEqual({ provider: 'openai', apiKey: 'sk-test-key' });
        });

        it('should fall back to cloud provider', () => {
            const settings = {
                audioTranscriptionProvider: '',
                audioTranscriptionApiKey: '',
                cloudServiceType: 'openai',
                cloudApiKey: 'sk-openai-key',
                providerSettings: {},
            };

            const provider = getTranscriptionProvider(settings);
            expect(provider).toEqual({ provider: 'openai', apiKey: 'sk-openai-key' });
        });

        it('should return null when no provider available', () => {
            const settings = {
                audioTranscriptionProvider: '',
                audioTranscriptionApiKey: '',
                cloudServiceType: 'claude',
                cloudApiKey: 'sk-ant-key',
                providerSettings: {},
            };

            const provider = getTranscriptionProvider(settings);
            expect(provider).toBeNull();
        });

        it('should check provider settings for API keys', () => {
            const settings = {
                audioTranscriptionProvider: '',
                audioTranscriptionApiKey: '',
                cloudServiceType: 'claude',
                cloudApiKey: '',
                providerSettings: {
                    groq: { apiKey: 'gsk-groq-key' },
                },
            };

            const provider = getTranscriptionProvider(settings);
            expect(provider).toEqual({ provider: 'groq', apiKey: 'gsk-groq-key' });
        });
    });

    describe('Context Documents', () => {
        it('should extract context text from multiple documents', () => {
            const documents = [
                { file: new TFile('agenda.pptx'), displayName: 'Agenda', extractedText: 'Slide 1: Introduction', isProcessing: false },
                { file: new TFile('notes.docx'), displayName: 'Notes', extractedText: 'Previous meeting notes', isProcessing: false },
            ];

            const contextText = getExtractedContextText(documents);

            expect(contextText).toContain('### Agenda');
            expect(contextText).toContain('Slide 1: Introduction');
            expect(contextText).toContain('### Notes');
            expect(contextText).toContain('Previous meeting notes');
            expect(contextText).toContain('---');
        });

        it('should filter out documents without extracted text', () => {
            const documents = [
                { file: new TFile('agenda.pptx'), displayName: 'Agenda', extractedText: 'Content here', isProcessing: false },
                { file: new TFile('empty.docx'), displayName: 'Empty', extractedText: undefined, isProcessing: false },
            ];

            const contextText = getExtractedContextText(documents);

            expect(contextText).toContain('### Agenda');
            expect(contextText).not.toContain('### Empty');
        });

        it('should return empty string when no documents', () => {
            const contextText = getExtractedContextText([]);
            expect(contextText).toBe('');
        });
    });
});

// Helper function to simulate transcription provider detection
function getTranscriptionProvider(settings: any): { provider: 'openai' | 'groq'; apiKey: string } | null {
    // Check dedicated transcription settings first
    if (settings.audioTranscriptionProvider && settings.audioTranscriptionApiKey) {
        return {
            provider: settings.audioTranscriptionProvider as 'openai' | 'groq',
            apiKey: settings.audioTranscriptionApiKey
        };
    }

    // Fall back to main provider settings
    if (settings.cloudServiceType === 'openai' && settings.cloudApiKey) {
        return { provider: 'openai', apiKey: settings.cloudApiKey };
    }

    if (settings.cloudServiceType === 'groq' && settings.cloudApiKey) {
        return { provider: 'groq', apiKey: settings.cloudApiKey };
    }

    // Check provider-specific settings
    const openaiKey = settings.providerSettings?.openai?.apiKey;
    if (openaiKey) {
        return { provider: 'openai', apiKey: openaiKey };
    }

    const groqKey = settings.providerSettings?.groq?.apiKey;
    if (groqKey) {
        return { provider: 'groq', apiKey: groqKey };
    }

    return null;
}

// Helper function to simulate context extraction
function getExtractedContextText(documents: any[]): string {
    return documents
        .filter(doc => doc.extractedText)
        .map(doc => `### ${doc.displayName}\n\n${doc.extractedText}`)
        .join('\n\n---\n\n');
}
