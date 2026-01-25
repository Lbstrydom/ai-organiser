/**
 * Minutes auto-fill tests (production-driven)
 * These tests call the real MinutesCreationModal logic via private method access.
 */

import { vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, mockNotices, clearMockNotices } from './mocks/obsidian';
import { MinutesCreationModal } from '../src/ui/modals/MinutesCreationModal';

function createPlugin(overrides: Partial<any> = {}) {
    return {
        settings: {
            minutesDefaultPersona: 'corporate-minutes',
            minutesObsidianTasksFormat: true,
            pluginFolder: 'AI-Organiser',
            minutesDefaultTimezone: 'UTC',
            minutesOutputFolder: 'Minutes',
            audioTranscriptionProvider: '',
            audioTranscriptionApiKey: '',
            cloudServiceType: 'openai',
            cloudApiKey: '',
            providerSettings: {},
            ...overrides.settings
        },
        t: {
            minutes: {
                dictionaryAutoExtracting: 'Extracting terminology from documents...',
                agendaAutoFilled: 'Agenda auto-filled from document',
                participantsAutoExtracted: 'Participants auto-extracted'
            }
        },
        ...overrides
    } as any;
}

function createModal(pluginOverrides: Partial<any> = {}) {
    const app = new App();
    const plugin = createPlugin(pluginOverrides);
    const modal = new MinutesCreationModal(app as any, plugin);
    return { app, plugin, modal };
}

describe('MinutesCreationModal auto-fill logic', () => {
    beforeEach(() => {
        clearMockNotices();
        vi.clearAllMocks();
    });

    describe('Agenda extraction', () => {
        it('strips list prefixes while preserving times', () => {
            const { modal } = createModal();
            const text = `Agenda\n1. 10.00 - 10.05 Opening\n2. Budget review`;

            const agenda = (modal as any).extractAgendaItems(text);

            expect(agenda).toContain('10.00 - 10.05 Opening');
            expect(agenda).toContain('Budget review');
            expect(agenda).not.toContain('1.');
        });

        it('does not treat time formats as list prefixes', () => {
            const { modal } = createModal();
            const text = `10.00 - 10.05 Opening\n10.05 - 10.10 Updates`;

            const agenda = (modal as any).extractAgendaItems(text);

            expect(agenda).toBe('');
        });

        it('stops agenda parsing at attendee sections', () => {
            const { modal } = createModal();
            const text = `Agenda\n- Item one\nAttendees\n- John Smith`;

            const agenda = (modal as any).extractAgendaItems(text);

            expect(agenda).toContain('Item one');
            expect(agenda).not.toContain('John Smith');
        });
    });

    describe('Participant extraction', () => {
        it('extracts and cleans participant names from sections', () => {
            const { modal } = createModal();
            const text = `Participants\n- John Smith (CEO) - Present\n- Mary Jane [Board Member]`;

            const names = (modal as any).extractParticipantNames(text);

            expect(names).toContain('John Smith');
            expect(names).toContain('Mary Jane');
            expect(names.some((n: string) => n.includes('CEO'))).toBe(false);
        });

        it('ignores non-name lines', () => {
            const { modal } = createModal();
            const text = `Participants\n- john smith\n- john.smith@example.com`;

            const names = (modal as any).extractParticipantNames(text);

            expect(names).toHaveLength(0);
        });
    });

    describe('Transcription settings', () => {
        it('returns undefined language for auto-detect', () => {
            const { modal } = createModal();
            (modal as any).state.transcriptionLanguage = 'auto';
            expect((modal as any).getTranscriptionLanguageCode()).toBeUndefined();
        });

        it('returns explicit language codes when selected', () => {
            const { modal } = createModal();
            (modal as any).state.transcriptionLanguage = 'fi';
            expect((modal as any).getTranscriptionLanguageCode()).toBe('fi');
        });

        it('prefers dedicated transcription provider settings', () => {
            const { modal } = createModal({
                settings: {
                    audioTranscriptionProvider: 'openai',
                    audioTranscriptionApiKey: 'sk-test'
                }
            });

            const provider = (modal as any).getTranscriptionProvider();
            expect(provider).toEqual({ provider: 'openai', apiKey: 'sk-test' });
        });

        it('falls back to cloud provider settings', () => {
            const { modal } = createModal({
                settings: {
                    cloudServiceType: 'groq',
                    cloudApiKey: 'gsk-test'
                }
            });

            const provider = (modal as any).getTranscriptionProvider();
            expect(provider).toEqual({ provider: 'groq', apiKey: 'gsk-test' });
        });

        it('falls back to providerSettings api keys', () => {
            const { modal } = createModal({
                settings: {
                    cloudServiceType: 'claude',
                    cloudApiKey: '',
                    providerSettings: { openai: { apiKey: 'sk-provider' } }
                }
            });

            const provider = (modal as any).getTranscriptionProvider();
            expect(provider).toEqual({ provider: 'openai', apiKey: 'sk-provider' });
        });
    });

    describe('Dictionary auto-extract trigger', () => {
        it('offers extraction once when dictionary selected and docs extracted', () => {
            const { modal } = createModal();
            (modal as any).state.selectedDictionaryId = 'dict-1';
            (modal as any).docController = {
                getDocuments: () => [{ extractedText: 'content' }]
            };
            (modal as any).handleExtractDictionaryFromDocs = vi.fn();

            (modal as any).tryOfferDictionaryExtraction();

            expect((modal as any).state.dictionaryAutoExtractOffered).toBe(true);
            expect((modal as any).handleExtractDictionaryFromDocs).toHaveBeenCalled();
            expect(mockNotices.length).toBeGreaterThan(0);
        });

        it('does not offer extraction without a selected dictionary', () => {
            const { modal } = createModal();
            (modal as any).docController = {
                getDocuments: () => [{ extractedText: 'content' }]
            };
            (modal as any).handleExtractDictionaryFromDocs = vi.fn();

            (modal as any).tryOfferDictionaryExtraction();

            expect((modal as any).state.dictionaryAutoExtractOffered).toBe(false);
            expect((modal as any).handleExtractDictionaryFromDocs).not.toHaveBeenCalled();
        });
    });
});
