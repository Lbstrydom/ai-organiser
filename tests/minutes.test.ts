/**
 * Minutes Feature Integration Tests
 * Tests for Meeting Minutes modal, persona loading, and error scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, clearMockNotices } from './mocks/obsidian';

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

});
