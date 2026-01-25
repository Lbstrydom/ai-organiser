/**
 * MinutesService tests (production-driven)
 * Tests exercise generateMinutes() via public API with mocked edges:
 * - Obsidian vault (create, getAbstractFileByPath)
 * - Config service (getMinutesPersonaPrompt)
 * - LLM service (summarizeText)
 * - Notice side effects
 * - Text chunking helpers when needed
 */

import { vi } from 'vitest';
import { MinutesService, MinutesGenerationInput } from '../src/services/minutesService';
import { CHUNK_TOKEN_LIMIT } from '../src/core/constants';
import { App, TFile, clearMockNotices } from './mocks/obsidian';
import { Notice } from 'obsidian';

// Mock Notice to suppress console output in tests
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        Notice: class MockNotice {
            constructor(msg: string, timeout?: number) {
                // Silent in tests
            }
        }
    };
});

describe('MinutesService', () => {
    let app: App;
    let service: MinutesService;
    let mockPlugin: any;
    let mockLLMService: any;
    let mockConfigService: any;
    let createdFiles: Map<string, string>;
    let folders: Set<string>;

    const baseMetadata = {
        title: 'Project Kickoff',
        date: '2025-01-20',
        startTime: '10:00',
        endTime: '11:00',
        timezone: 'UTC',
        meetingContext: 'internal' as const,
        outputAudience: 'internal' as const,
        confidentialityLevel: 'internal' as const,
        chair: 'Alice',
        location: 'Zoom',
        agenda: ['Introductions', 'Project scope'],
        dualOutput: false,
        obsidianTasksFormat: false,
        minuteTaker: 'Bob'
    };

    const baseInput: MinutesGenerationInput = {
        metadata: baseMetadata,
        participantsRaw: 'Alice\nBob\nCarol',
        transcript: 'Alice: Welcome everyone.\nBob: Thanks for organizing.',
        personaId: 'professional',
        outputFolder: 'Meetings',
        customInstructions: '',
        languageOverride: '',
        contextDocuments: '',
        dictionaryContent: ''
    };

    const sampleMinutesResponse = `# Minutes

## Summary
This was a kickoff meeting.

## Actions
- [ ] Alice to send agenda @due(2025-01-25)

<!-- AI-GENERATED-MINUTES-JSON
{
  "metadata": {
    "title": "Project Kickoff",
    "date": "2025-01-20",
    "start_time": "10:00",
    "end_time": "11:00",
    "timezone": "UTC",
    "meeting_context": "internal",
    "output_audience": "internal",
    "confidentiality_level": "internal",
    "chair": "Alice",
    "minute_taker": "Bob",
    "location": "Zoom",
    "quorum_present": true
  },
  "participants": [
    {"name": "Alice", "attendance": "present"},
    {"name": "Bob", "attendance": "present"}
  ],
  "actions": [
    {"id": "1", "text": "Alice to send agenda", "owner": "Alice", "due_date": "2025-01-25", "confidence": "high"}
  ],
  "decisions": [],
  "risks": [],
  "notable_points": [],
  "open_questions": [],
  "deferred_items": []
}
-->`;

    beforeEach(() => {
        app = new App();
        createdFiles = new Map();
        folders = new Set();

        // Mock vault methods
        app.vault.create = vi.fn(async (path: string, content: string) => {
            createdFiles.set(path, content);
            return new TFile(path);
        });

        app.vault.getAbstractFileByPath = vi.fn((path: string) => {
            if (folders.has(path)) {
                return {} as any; // Folder exists
            }
            if (createdFiles.has(path)) {
                return new TFile(path);
            }
            return null;
        });

        app.vault.createFolder = vi.fn(async (path: string) => {
            folders.add(path);
        });

        // Mock LLM service
        mockLLMService = {
            summarizeText: vi.fn(async (prompt: string) => ({
                success: true,
                content: sampleMinutesResponse
            }))
        };

        // Mock config service
        mockConfigService = {
            getMinutesPersonaPrompt: vi.fn(async (personaId?: string) => {
                return 'You are a professional meeting minutes writer.';
            })
        };

        // Mock plugin
        mockPlugin = {
            app,
            llmService: mockLLMService,
            configService: mockConfigService,
            settings: {
                summaryLanguage: 'en'
            },
            t: {
                minutes: {
                    generatingChunk: 'Processing chunk {current}/{total}...',
                    consolidating: 'Consolidating minutes...'
                }
            }
        };

        service = new MinutesService(mockPlugin);
        clearMockNotices();
    });

    describe('Non-chunked path', () => {
        describe('Language fallback (3-level)', () => {
            it('uses valid override language when provided', async () => {
                const input = { ...baseInput, languageOverride: 'zh' };
                await service.generateMinutes(input);

                const prompt = mockLLMService.summarizeText.mock.calls[0][0];
                expect(prompt).toContain('Chinese (Simplified)');
            });

            it('falls back to settings.summaryLanguage when override is invalid', async () => {
                mockPlugin.settings.summaryLanguage = 'fr';
                const input = { ...baseInput, languageOverride: '' }; // Empty override
                await service.generateMinutes(input);

                const prompt = mockLLMService.summarizeText.mock.calls[0][0];
                expect(prompt).toContain('French');
            });

            it('defaults to American English when both override and settings are invalid', async () => {
                mockPlugin.settings.summaryLanguage = '';
                const input = { ...baseInput, languageOverride: '' };
                await service.generateMinutes(input);

                const prompt = mockLLMService.summarizeText.mock.calls[0][0];
                expect(prompt).toContain('American English');
            });
        });

        it('appends custom instructions to persona prompt', async () => {
            const input = {
                ...baseInput,
                customInstructions: 'Use bullet points only.'
            };
            await service.generateMinutes(input);

            const prompt = mockLLMService.summarizeText.mock.calls[0][0];
            expect(prompt).toContain('You are a professional meeting minutes writer.');
            expect(prompt).toContain('Additional instructions:');
            expect(prompt).toContain('Use bullet points only.');
        });

        it('writes file to vault with expected path and content structure', async () => {
            const result = await service.generateMinutes(baseInput);

            expect(result.filePath).toBe('Meetings/2025-01-20 Project Kickoff.md');
            expect(createdFiles.has(result.filePath)).toBe(true);

            const content = createdFiles.get(result.filePath)!;
            expect(content).toContain('---'); // Frontmatter
            expect(content).toContain('aio_meeting_title:'); // Uses aio_ prefix
            expect(content).toContain('Project Kickoff'); // Contains title in content
            expect(content).toContain('<!-- AIO_MINUTES_JSON:'); // JSON comment
        });

        it('creates output folder if it does not exist', async () => {
            await service.generateMinutes(baseInput);

            expect(app.vault.createFolder).toHaveBeenCalledWith('Meetings');
        });

        it('falls back to input title when model omits metadata.title', async () => {
            const responseWithoutTitle = sampleMinutesResponse.replace(
                '"title": "Project Kickoff"',
                '"title": ""'
            );
            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: true,
                content: responseWithoutTitle
            });

            const result = await service.generateMinutes(baseInput);

            const content = createdFiles.get(result.filePath)!;
            expect(content).toContain('aio_meeting_title: "Project Kickoff"'); // Fallback from input
        });

        it('falls back to input date when model omits metadata.date', async () => {
            const responseWithoutDate = sampleMinutesResponse.replace(
                '"date": "2025-01-20"',
                '"date": ""'
            );
            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: true,
                content: responseWithoutDate
            });

            const input = { ...baseInput, metadata: { ...baseMetadata, date: '2025-01-21' } };
            const result = await service.generateMinutes(input);

            expect(result.filePath).toContain('2025-01-21'); // Fallback from input
        });

        it('includes context documents in prompt when provided', async () => {
            const input = {
                ...baseInput,
                contextDocuments: 'Agenda:\n1. Budget review\n2. Q1 planning'
            };
            await service.generateMinutes(input);

            const prompt = mockLLMService.summarizeText.mock.calls[0][0];
            expect(prompt).toContain('Agenda:');
            expect(prompt).toContain('Budget review');
        });

        it('includes dictionary content in prompt when provided', async () => {
            const input = {
                ...baseInput,
                dictionaryContent: '# People\n- Alice Johnson (CEO)\n- Bob Smith (CTO)'
            };
            await service.generateMinutes(input);

            const prompt = mockLLMService.summarizeText.mock.calls[0][0];
            expect(prompt).toContain('Alice Johnson');
            expect(prompt).toContain('CTO');
        });
    });

    describe('Chunked path', () => {
        let chunkPlainTextAsyncSpy: any;
        let chunkSegmentsAsyncSpy: any;

        beforeEach(async () => {
            // Dynamically import and spy on chunking functions
            const textChunker = await import('../src/utils/textChunker');
            chunkPlainTextAsyncSpy = vi.spyOn(textChunker, 'chunkPlainTextAsync');
            chunkSegmentsAsyncSpy = vi.spyOn(textChunker, 'chunkSegmentsAsync');
        });

        it('throws when chunker returns zero chunks', async () => {
            chunkPlainTextAsyncSpy.mockResolvedValueOnce([]);
            
            const longTranscript = 'A'.repeat(CHUNK_TOKEN_LIMIT * 5); // Exceeds CHUNK_TOKEN_LIMIT * 4
            const input = { ...baseInput, transcript: longTranscript };

            await expect(service.generateMinutes(input)).rejects.toThrow('Transcript is empty');
        });

        it('uses chunkPlainTextAsync for string transcripts', async () => {
            const chunkResponse = `{
                "actions": [{"id": "1", "text": "Review draft", "owner": "Alice", "due_date": "2025-01-25", "confidence": "high"}],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1 text', 'Chunk 2 text']);
            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(CHUNK_TOKEN_LIMIT * 5);
            const input = { ...baseInput, transcript: longTranscript };

            await service.generateMinutes(input);

            expect(chunkPlainTextAsyncSpy).toHaveBeenCalledWith(longTranscript, {
                maxTokens: CHUNK_TOKEN_LIMIT,
                overlapChars: 500
            });
        });

        it('uses chunkSegmentsAsync for segment array transcripts', async () => {
            const chunkResponse = `{
                "actions": [],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            const segments = Array(1000).fill(null).map((_, i) => ({
                t: `${i}:00`,
                speaker: 'Alice',
                text: 'This is a very long meeting transcript segment that will trigger chunking. '.repeat(5)
            }));

            chunkSegmentsAsyncSpy.mockResolvedValueOnce([
                [segments[0], segments[1]],
                [segments[2], segments[3]]
            ]);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const input = { ...baseInput, transcript: segments };

            await service.generateMinutes(input);

            expect(chunkSegmentsAsyncSpy).toHaveBeenCalledWith(segments, {
                maxTokens: CHUNK_TOKEN_LIMIT,
                overlapChars: 500
            });
        });

        it('calls chunk extraction for each chunk', async () => {
            const chunkResponse = `{
                "actions": [],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1', 'Chunk 2', 'Chunk 3']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await service.generateMinutes(input);

            // 3 chunk extractions + 1 consolidation = 4 total calls
            expect(mockLLMService.summarizeText).toHaveBeenCalledTimes(4);
        });

        it('deduplicates actions across chunks using normalization', async () => {
            const chunk1Response = `{
                "actions": [
                    {"id": "1", "text": "Alice to review the budget proposal and provide feedback by next week", "owner": "Alice", "due_date": "2025-01-27", "confidence": "high"}
                ],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            const chunk2Response = `{
                "actions": [
                    {"id": "2", "text": "Alice TO REVIEW the  budget   proposal and provide  feedback by next week", "owner": "Alice", "due_date": "2025-01-27", "confidence": "high"},
                    {"id": "3", "text": "Bob to schedule follow-up meeting", "owner": "Bob", "due_date": "2025-01-28", "confidence": "medium"}
                ],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1', 'Chunk 2']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunk1Response })
                .mockResolvedValueOnce({ success: true, content: chunk2Response })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await service.generateMinutes(input);

            const consolidationCall = mockLLMService.summarizeText.mock.calls[2][0];
            // Consolidation prompt: "...prompt text...\n\n{JSON.stringify(payload)}"
            // Extract the JSON after the last occurrence of "\n\n"
            const parts = consolidationCall.split('\n\n');
            const consolidationPayload = JSON.parse(parts[parts.length - 1]);

            // Should only have 2 actions (duplicate removed by 120-char normalization)
            expect(consolidationPayload.extracts.actions).toHaveLength(2);
            expect(consolidationPayload.extracts.actions[0].text).toContain('Alice to review');
            expect(consolidationPayload.extracts.actions[1].text).toContain('Bob to schedule');
        });

        it('deduplicates decisions across chunks', async () => {
            const chunk1Response = `{
                "actions": [],
                "decisions": [
                    {"id": "1", "text": "Approved budget increase of 15%", "confidence": "high"}
                ],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            const chunk2Response = `{
                "actions": [],
                "decisions": [
                    {"id": "2", "text": "APPROVED  BUDGET increase of   15%", "confidence": "high"},
                    {"id": "3", "text": "Postponed hiring decision until Q2", "confidence": "medium"}
                ],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1', 'Chunk 2']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunk1Response })
                .mockResolvedValueOnce({ success: true, content: chunk2Response })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await service.generateMinutes(input);

            const consolidationCall = mockLLMService.summarizeText.mock.calls[2][0];
            const parts = consolidationCall.split('\n\n');
            const consolidationPayload = JSON.parse(parts[parts.length - 1]);

            expect(consolidationPayload.extracts.decisions).toHaveLength(2);
        });

        it('uses first 120 chars for deduplication boundary', async () => {
            // Create two actions that are identical in first 120 chars but different after
            // Normalization: lowercase + whitespace collapse + first 120 chars
            // "A".repeat(119) + "X" becomes "a".repeat(119) + "x" (120 chars)
            // "A".repeat(119) + "Y" becomes "a".repeat(119) + "y" (120 chars)
            // First 120 chars: both are "a".repeat(119) + first char of X or Y = different!
            // We need them to match in the first 120, so make the difference at position 121+
            const baseText = 'A'.repeat(120); // Exactly 120 chars
            const chunk1Response = `{
                "actions": [
                    {"id": "1", "text": "${baseText} extra text one", "owner": "Alice", "due_date": "2025-01-27", "confidence": "high"}
                ],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            const chunk2Response = `{
                "actions": [
                    {"id": "2", "text": "${baseText} extra text two", "owner": "Alice", "due_date": "2025-01-27", "confidence": "high"}
                ],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1', 'Chunk 2']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunk1Response })
                .mockResolvedValueOnce({ success: true, content: chunk2Response })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'B'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await service.generateMinutes(input);

            const consolidationCall = mockLLMService.summarizeText.mock.calls[2][0];
            const parts = consolidationCall.split('\n\n');
            const consolidationPayload = JSON.parse(parts[parts.length - 1]);

            // Both actions have same first 120 chars after normalization, should deduplicate to 1
            expect(consolidationPayload.extracts.actions).toHaveLength(1);
        });

        it('includes dictionary content in consolidation payload when provided', async () => {
            const chunkResponse = `{
                "actions": [],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(30000);
            const input = {
                ...baseInput,
                transcript: longTranscript,
                dictionaryContent: '# People\n- Alice Johnson (CEO)'
            };

            await service.generateMinutes(input);

            const consolidationCall = mockLLMService.summarizeText.mock.calls[1][0];
            const parts = consolidationCall.split('\n\n');
            const consolidationPayload = JSON.parse(parts[parts.length - 1]);

            expect(consolidationPayload.terminology_dictionary).toBe('# People\n- Alice Johnson (CEO)');
        });

        it('excludes dictionary content when blank or whitespace-only', async () => {
            const chunkResponse = `{
                "actions": [],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            chunkPlainTextAsyncSpy.mockResolvedValueOnce(['Chunk 1']);

            mockLLMService.summarizeText
                .mockResolvedValueOnce({ success: true, content: chunkResponse })
                .mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

            const longTranscript = 'A'.repeat(30000);
            const input = {
                ...baseInput,
                transcript: longTranscript,
                dictionaryContent: '   \n  \t  '
            };

            await service.generateMinutes(input);

            const consolidationCall = mockLLMService.summarizeText.mock.calls[1][0];
            const parts = consolidationCall.split('\n\n');
            const consolidationPayload = JSON.parse(parts[parts.length - 1]);

            expect(consolidationPayload.terminology_dictionary).toBeUndefined();
        });
    });

    describe('Failure paths', () => {
        it('surfaces LLM failure message from summarizeText', async () => {
            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: false,
                error: 'API rate limit exceeded'
            });

            await expect(service.generateMinutes(baseInput)).rejects.toThrow('API rate limit exceeded');
        });

        it('throws default error when LLM fails without error message', async () => {
            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: false
            });

            await expect(service.generateMinutes(baseInput)).rejects.toThrow('Failed to generate minutes');
        });

        it('handles missing summarizeText function with clear error', async () => {
            mockPlugin.llmService = {}; // No summarizeText method

            await expect(service.generateMinutes(baseInput)).rejects.toThrow(
                'LLM service does not support summarization'
            );
        });

        it('fails fast on unrecoverable chunk JSON parsing errors', async () => {
            const textChunker = await import('../src/utils/textChunker');
            vi.spyOn(textChunker, 'chunkPlainTextAsync')
                .mockResolvedValueOnce(['Chunk 1']);

            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: true,
                content: 'Not valid JSON at all { unclosed bracket'
            });

            const longTranscript = 'A'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await expect(service.generateMinutes(input)).rejects.toThrow();
        });
    });
});
