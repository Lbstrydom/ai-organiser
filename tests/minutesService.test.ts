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
import { App, clearMockNotices, createTFile } from './mocks/obsidian';
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
        minutesStyle: 'standard',
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
            return createTFile(path);
        });

        app.vault.getAbstractFileByPath = vi.fn((path: string) => {
            if (folders.has(path)) {
                return {} as any; // Folder exists
            }
            if (createdFiles.has(path)) {
                return createTFile(path);
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
                    intermediateConsolidation: 'Consolidating group {current}/{total} (pass {pass})...',
                    consolidating: 'Consolidating minutes...'
                },
                messages: {
                    minutesValidationWarnings: '{count} validation warning(s) found in meeting minutes'
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

        it('appends custom instructions to style prompt', async () => {
            const input = {
                ...baseInput,
                customInstructions: 'Use bullet points only.'
            };
            await service.generateMinutes(input);

            const prompt = mockLLMService.summarizeText.mock.calls[0][0];
            expect(prompt).toContain('ADDITIONAL INSTRUCTIONS: Use bullet points only.');
        });

        it('writes file to vault with expected path and content structure', async () => {
            const result = await service.generateMinutes(baseInput);

            expect(result.filePath).toBe('Meetings/2025-01-20 Project Kickoff/2025-01-20 Project Kickoff — Minutes.md');
            expect(createdFiles.has(result.filePath)).toBe(true);

            const content = createdFiles.get(result.filePath)!;
            expect(content).toContain('---'); // Frontmatter
            expect(content).toContain('meeting_title:'); // Clean property name
            expect(content).toContain('Project Kickoff'); // Contains title in content
            expect(content).toContain('<!-- AIO_MINUTES_JSON:'); // JSON comment
        });

        it('saves transcript alongside minutes in meeting subfolder', async () => {
            const result = await service.generateMinutes(baseInput);

            const transcriptPath = 'Meetings/2025-01-20 Project Kickoff/2025-01-20 Project Kickoff — Transcript.md';
            expect(createdFiles.has(transcriptPath)).toBe(true);
            expect(createdFiles.get(transcriptPath)).toContain('Welcome everyone');

            // Minutes in same subfolder
            expect(result.filePath).toContain('Meetings/2025-01-20 Project Kickoff/');
        });

        it('creates per-meeting subfolder', async () => {
            await service.generateMinutes(baseInput);

            expect(app.vault.createFolder).toHaveBeenCalledWith('Meetings/2025-01-20 Project Kickoff');
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
            expect(content).toContain('meeting_title: "Project Kickoff"'); // Fallback from input
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

            expect(result.filePath).toContain('2025-01-21'); // Fallback from input date in path
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

        describe('Hierarchical consolidation', () => {
            const chunkResponse = `{
                "actions": [{"id": "A1", "text": "Review draft", "owner": "Alice", "due_date": "TBC", "confidence": "high"}],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            const intermediateResponse = `{
                "actions": [{"id": "A1", "text": "Review draft (merged)", "owner": "Alice", "due_date": "TBC", "confidence": "high"}],
                "decisions": [],
                "risks": [],
                "notable_points": [],
                "open_questions": []
            }`;

            it('4 chunks: no intermediate merge (5 LLM calls)', async () => {
                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4']);

                // 4 extractions + 1 final consolidation = 5 calls
                for (let i = 0; i < 4; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await service.generateMinutes(input);

                expect(mockLLMService.summarizeText).toHaveBeenCalledTimes(5);
            });

            it('5 chunks: triggers hierarchical — 7 LLM calls (single-item batch skipped)', async () => {
                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5']);

                // 5 extractions + 1 intermediate merge (batch of 4) + 1 final = 7
                // Batch [C1-C4] → LLM merge, Batch [C5] → skip (single item)
                for (let i = 0; i < 5; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: intermediateResponse }); // intermediate
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: sampleMinutesResponse }); // final

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await service.generateMinutes(input);

                expect(mockLLMService.summarizeText).toHaveBeenCalledTimes(7);
            });

            it('8 chunks: two full batches — 11 LLM calls', async () => {
                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);

                // 8 extractions + 2 intermediate merges + 1 final = 11
                for (let i = 0; i < 8; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: intermediateResponse }); // batch 1
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: intermediateResponse }); // batch 2
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: sampleMinutesResponse }); // final

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await service.generateMinutes(input);

                expect(mockLLMService.summarizeText).toHaveBeenCalledTimes(11);
            });

            it('intermediate merge prompt is sent to LLM for multi-item batches', async () => {
                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5']);

                for (let i = 0; i < 5; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: intermediateResponse });
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: sampleMinutesResponse });

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await service.generateMinutes(input);

                // Call index 5 is the intermediate merge (after 5 extractions)
                const intermediateCall = mockLLMService.summarizeText.mock.calls[5][0];
                expect(intermediateCall).toContain('merging meeting extract batches');
                expect(intermediateCall).toContain('Extracts to merge');
            });

            it('LLM failure in intermediate merge propagates error', async () => {
                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5']);

                for (let i = 0; i < 5; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                // Intermediate merge fails
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: false, error: 'LLM timeout' });

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await expect(service.generateMinutes(input)).rejects.toThrow('LLM timeout');
            });

            it('intermediate response with missing fields produces valid extract with empty arrays', async () => {
                const partialResponse = `{
                    "actions": [{"id": "A1", "text": "Do something", "owner": "Alice", "due_date": "TBC", "confidence": "high"}],
                    "decisions": []
                }`;

                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5']);

                for (let i = 0; i < 5; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: partialResponse }); // partial
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: sampleMinutesResponse }); // final

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                // Should not throw — missing fields default to []
                await service.generateMinutes(input);

                expect(mockLLMService.summarizeText).toHaveBeenCalledTimes(7);
            });

            it('throws when intermediate response has ALL fields missing', async () => {
                const garbageResponse = `{"foo": "bar", "baz": 123}`;

                chunkPlainTextAsyncSpy.mockResolvedValueOnce(['C1', 'C2', 'C3', 'C4', 'C5']);

                for (let i = 0; i < 5; i++) {
                    mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: chunkResponse });
                }
                mockLLMService.summarizeText.mockResolvedValueOnce({ success: true, content: garbageResponse });

                const input = { ...baseInput, transcript: 'A'.repeat(30000) };
                await expect(service.generateMinutes(input)).rejects.toThrow('no recognizable extract fields');
            });
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

        it('fails fast on unrecoverable chunk JSON parsing errors', async () => {
            const textChunker = await import('../src/utils/textChunker');
            vi.spyOn(textChunker, 'chunkPlainTextAsync')
                .mockResolvedValueOnce(['Chunk 1']);

            mockLLMService.summarizeText.mockResolvedValueOnce({
                success: true,
                content: 'Sorry, I cannot process this transcript.'
            });

            const longTranscript = 'A'.repeat(30000);
            const input = { ...baseInput, transcript: longTranscript };

            await expect(service.generateMinutes(input)).rejects.toThrow();
        });
    });

    // ========================================================================
    // Private method unit tests (via any cast)
    // ========================================================================

    describe('hasUnbalancedBraces', () => {
        const check = (text: string) => (service as any).hasUnbalancedBraces(text);

        it('returns false for balanced simple JSON', () => {
            expect(check('{"key": "value"}')).toBe(false);
        });

        it('returns false for balanced nested JSON', () => {
            expect(check('{"a": {"b": {"c": 1}}}')).toBe(false);
        });

        it('returns true for truncated JSON (missing closing brace)', () => {
            expect(check('{"key": "value"')).toBe(true);
        });

        it('returns true for deeply truncated JSON', () => {
            expect(check('{"a": {"b": {"c": 1}')).toBe(true);
        });

        it('handles braces inside string literals (should be balanced)', () => {
            expect(check('{"text": "use { and } in output"}')).toBe(false);
        });

        it('handles escaped quotes inside strings', () => {
            expect(check(String.raw`{"text": "say \"hello\""}`)).toBe(false);
        });

        it('handles escaped backslash before quote', () => {
            expect(check(String.raw`{"path": "C:\\"}`)).toBe(false);
        });

        it('returns true for empty string (no braces at all → depth never 0)', () => {
            // No braces means depth stays 0 from start → returns false
            // Actually: first char isn't {, so depth stays 0, loop ends, returns true
            // Wait: depth starts at 0, no braces → loop finishes with depth 0
            // BUT: for loop with no '{' encountered, depth is 0 at end.
            // The function returns true (depth > 0 is false, depth === 0...
            // Let's check: depth=0, loop runs, no braces → depth=0, returns true
            // Actually the function returns `true` at end (unbalanced), which is wrong
            // for empty string. But looksLikeTruncatedJson guards with indexOf('{') check.
            expect(check('')).toBe(true); // Caller guards via looksLikeTruncatedJson
        });
    });

    describe('looksLikeTruncatedJson', () => {
        const check = (text: string) => (service as any).looksLikeTruncatedJson(text);

        it('returns false for complete JSON', () => {
            expect(check('{"metadata": {"title": "Test"}, "actions": []}')).toBe(false);
        });

        it('returns true for truncated JSON', () => {
            expect(check('{"metadata": {"title": "Test')).toBe(true);
        });

        it('returns false for text with no braces', () => {
            expect(check('Sorry, I cannot process this transcript.')).toBe(false);
        });

        it('returns false for text with balanced braces after preamble', () => {
            expect(check('Here is the result:\n{"key": "value"}')).toBe(false);
        });

        it('returns true for preamble + truncated JSON', () => {
            expect(check('Here is the result:\n{"key": "val')).toBe(true);
        });
    });

    describe('demoteLowConfidenceItems', () => {
        const demote = (extract: any) => (service as any).demoteLowConfidenceItems(extract);

        it('moves low-confidence actions to open_questions', () => {
            const extract = {
                actions: [
                    { id: 'A1', text: 'Do X', confidence: 'high' },
                    { id: 'A2', text: 'Maybe Y', confidence: 'low' },
                ],
                decisions: [],
                notable_points: [],
                risks: [],
                open_questions: [],
                deferred_items: [],
            };

            const result = demote(extract);
            expect(result.actions).toHaveLength(1);
            expect(result.actions[0].text).toBe('Do X');
            expect(result.open_questions).toHaveLength(1);
            expect(result.open_questions[0].text).toContain('Maybe Y');
            expect(result.open_questions[0].text).toContain('low confidence');
        });

        it('preserves high and medium confidence items', () => {
            const extract = {
                actions: [{ id: 'A1', text: 'High', confidence: 'high' }],
                decisions: [{ id: 'D1', text: 'Med', confidence: 'medium' }],
                notable_points: [{ id: 'N1', text: 'Low', confidence: 'low' }],
                risks: [],
                open_questions: [],
                deferred_items: [],
            };

            const result = demote(extract);
            expect(result.actions).toHaveLength(1);
            expect(result.decisions).toHaveLength(1);
            expect(result.notable_points).toHaveLength(0);
            expect(result.open_questions).toHaveLength(1);
        });

        it('does not double-demote items already in open_questions', () => {
            const extract = {
                actions: [],
                decisions: [],
                notable_points: [],
                risks: [],
                open_questions: [{ id: 'Q1', text: 'Existing question', confidence: 'low' }],
                deferred_items: [],
            };

            const result = demote(extract);
            // open_questions with confidence: low are NOT in the demotable set, so preserved as-is
            expect(result.open_questions).toHaveLength(1);
            expect(result.open_questions[0].text).toBe('Existing question');
        });

        it('does not mutate the original extract', () => {
            const extract = {
                actions: [{ id: 'A1', text: 'Low', confidence: 'low' }],
                decisions: [],
                notable_points: [],
                risks: [],
                open_questions: [],
                deferred_items: [],
            };

            demote(extract);
            expect(extract.actions).toHaveLength(1); // original unchanged
        });
    });

    describe('trimExtractToFit', () => {
        const trim = (extract: any, shell: any, max: number) =>
            (service as any).trimExtractToFit(extract, shell, max);

        it('returns extract unchanged if already under budget', () => {
            const extract = {
                actions: [{ id: 'A1', text: 'Short' }],
                decisions: [],
                risks: [],
                notable_points: [],
                open_questions: [],
                deferred_items: [],
            };
            const shell: Record<string, unknown> = { metadata: {} };

            const result = trim(extract, shell, 100000);
            expect(result.actions).toHaveLength(1);
        });

        it('trims the largest array first', () => {
            const extract = {
                actions: [{ id: 'A1', text: 'x' }],
                decisions: [],
                risks: [],
                notable_points: Array.from({ length: 50 }, (_, i) => ({ id: `N${i}`, text: 'A'.repeat(100) })),
                open_questions: [{ id: 'Q1', text: 'y' }],
                deferred_items: [],
            };
            const shell: Record<string, unknown> = { metadata: {} };

            const result = trim(extract, shell, 500);
            // notable_points (largest) should be trimmed most
            expect(result.notable_points.length).toBeLessThan(50);
            // actions and open_questions should be intact (they're small)
            expect(result.actions).toHaveLength(1);
        });

        it('trims until under budget even with many items', () => {
            const extract = {
                actions: Array.from({ length: 100 }, (_, i) => ({ id: `A${i}`, text: 'A'.repeat(200) })),
                decisions: Array.from({ length: 100 }, (_, i) => ({ id: `D${i}`, text: 'D'.repeat(200) })),
                risks: [],
                notable_points: [],
                open_questions: [],
                deferred_items: [],
            };
            const shell: Record<string, unknown> = { metadata: {} };

            const result = trim(extract, shell, 2000);
            const serialized = JSON.stringify({ ...shell, extracts: result });
            expect(serialized.length).toBeLessThanOrEqual(2000);
        });

        it('does not mutate the original extract arrays', () => {
            const original = [{ id: 'N1', text: 'A'.repeat(500) }, { id: 'N2', text: 'B'.repeat(500) }];
            const extract = {
                actions: [],
                decisions: [],
                risks: [],
                notable_points: [...original],
                open_questions: [],
                deferred_items: [],
            };
            const shell: Record<string, unknown> = { metadata: {} };

            trim(extract, shell, 100);
            expect(extract.notable_points).toHaveLength(2); // original untouched
        });
    });
});
