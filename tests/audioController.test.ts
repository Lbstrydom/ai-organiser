/**
 * Tests for AudioController
 * Comprehensive validation of audio state management and transcription
 */

import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { AudioController } from '../src/ui/controllers/AudioController';
import { App, TFile } from 'obsidian';

// Mock imports
vi.mock('../src/utils/embeddedContentDetector', () => ({
    detectEmbeddedAudio: vi.fn()
}));

vi.mock('../src/services/audioTranscriptionService', () => ({
    transcribeAudio: vi.fn(),
    transcribeChunkedAudioWithCleanup: vi.fn()
}));

vi.mock('../src/services/audioCompressionService', () => ({
    needsChunking: vi.fn(),
    compressAndChunkAudio: vi.fn()
}));

import { detectEmbeddedAudio } from '../src/utils/embeddedContentDetector';
import { transcribeAudio, transcribeChunkedAudioWithCleanup } from '../src/services/audioTranscriptionService';
import { needsChunking, compressAndChunkAudio } from '../src/services/audioCompressionService';

describe('AudioController', () => {
    let controller: AudioController;
    let mockApp: App;
    let mockFile1: TFile;
    let mockFile2: TFile;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();

        // Create mock app
        mockApp = {} as App;

        // Create mock files
        mockFile1 = {
            path: 'audio/meeting1.mp3',
            name: 'meeting1.mp3',
            extension: 'mp3'
        } as TFile;

        mockFile2 = {
            path: 'audio/meeting2.m4a',
            name: 'meeting2.m4a',
            extension: 'm4a'
        } as TFile;

        controller = new AudioController(mockApp);
    });

    // === State Management Tests ===

    describe('State Management', () => {
        it('should start with empty state', () => {
            expect(controller.getCount()).toBe(0);
            expect(controller.getItems()).toEqual([]);
            expect(controller.isAnyTranscribing()).toBe(false);
        });

        it('should return immutable items array', () => {
            // Add mock detection result
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');

            const items1 = controller.getItems();
            const items2 = controller.getItems();

            // Different array references
            expect(items1).not.toBe(items2);
            expect(items1).toEqual(items2);

            // Mutating returned array doesn't affect internal state
            items1.push({
                id: 'fake.mp3',
                file: {} as TFile,
                displayName: 'fake.mp3',
                isTranscribing: false
            });

            expect(controller.getItems().length).toBe(1);
        });

        it('should return immutable single item', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');

            const item = controller.getItem('audio/meeting1.mp3');
            expect(item).not.toBeNull();
            expect(item?.id).toBe('audio/meeting1.mp3');

            // Mutating returned object doesn't affect internal state
            if (item) {
                item.transcript = 'mutated';
            }

            const item2 = controller.getItem('audio/meeting1.mp3');
            expect(item2?.transcript).toBeUndefined();
        });

        it('should return null for non-existent item', () => {
            const item = controller.getItem('nonexistent.mp3');
            expect(item).toBeNull();
        });

        it('should clear all items', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');
            expect(controller.getCount()).toBe(1);

            controller.clear();
            expect(controller.getCount()).toBe(0);
            expect(controller.getItems()).toEqual([]);
        });
    });

    // === Detection Tests ===

    describe('Detection', () => {
        it('should detect audio from content without state change', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            const detected = controller.detectFromContent('content');

            expect(detected.length).toBe(1);
            expect(detected[0].id).toBe('audio/meeting1.mp3');
            expect(detected[0].displayName).toBe('meeting1.mp3');
            expect(detected[0].file).toBe(mockFile1);
            expect(detected[0].isTranscribing).toBe(false);
            expect(detected[0].transcript).toBeUndefined();

            // State unchanged
            expect(controller.getCount()).toBe(0);
        });

        it('should skip items without resolved files', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'missing.mp3',
                    resolvedFile: undefined
                }
            ]);

            const detected = controller.detectFromContent('content');
            expect(detected.length).toBe(0);
        });

        it('should add detected audio to state', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                },
                {
                    type: 'audio',
                    displayName: 'meeting2.m4a',
                    resolvedFile: mockFile2
                }
            ]);

            controller.addDetectedFromContent('content');

            expect(controller.getCount()).toBe(2);
            const items = controller.getItems();
            expect(items[0].id).toBe('audio/meeting1.mp3');
            expect(items[1].id).toBe('audio/meeting2.m4a');
        });

        it('should deduplicate by file path', () => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');
            controller.addDetectedFromContent('content'); // Add again

            expect(controller.getCount()).toBe(1);
        });

        it('should pass current file to detector', () => {
            const mockCurrentFile = {} as TFile;

            (detectEmbeddedAudio as Mock).mockReturnValue([]);

            controller.detectFromContent('content', mockCurrentFile);

            expect(detectEmbeddedAudio).toHaveBeenCalledWith(
                mockApp,
                'content',
                mockCurrentFile
            );
        });
    });

    // === Transcription Tests ===

    describe('Transcription', () => {
        beforeEach(() => {
            // Add items for transcription tests
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');
        });

        it('should transcribe audio without chunking', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Test transcript'
            });

            const result = await controller.transcribe(
                'audio/meeting1.mp3',
                'openai',
                'test-api-key'
            );

            expect(result.errors).toEqual([]);
            expect(result.value).toBe('Test transcript');

            // Verify item updated
            const item = controller.getItem('audio/meeting1.mp3');
            expect(item?.transcript).toBe('Test transcript');
            expect(item?.isTranscribing).toBe(false);
            expect(item?.error).toBeUndefined();
        });

        it('should transcribe audio with chunking', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: true });
            (compressAndChunkAudio as Mock).mockResolvedValue({
                success: true,
                chunks: ['chunk1.mp3', 'chunk2.mp3'],
                outputDir: '/tmp/chunks'
            });
            (transcribeChunkedAudioWithCleanup as Mock).mockResolvedValue({
                success: true,
                transcript: 'Chunked transcript'
            });

            const result = await controller.transcribe(
                'audio/meeting1.mp3',
                'groq',
                'test-api-key'
            );

            expect(result.errors).toEqual([]);
            expect(result.value).toBe('Chunked transcript');

            const item = controller.getItem('audio/meeting1.mp3');
            expect(item?.transcript).toBe('Chunked transcript');
        });

        it('should handle transcription errors', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: false,
                error: 'API error'
            });

            const result = await controller.transcribe(
                'audio/meeting1.mp3',
                'openai',
                'test-api-key'
            );

            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain('API error');
            expect(result.value).toBeUndefined();

            // Verify item has error
            const item = controller.getItem('audio/meeting1.mp3');
            expect(item?.error).toContain('API error');
            expect(item?.isTranscribing).toBe(false);
            expect(item?.transcript).toBeUndefined();
        });

        it('should return error for non-existent item', async () => {
            const result = await controller.transcribe(
                'nonexistent.mp3',
                'openai',
                'test-api-key'
            );

            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain('not found');
        });

        it('should validate provider and API key', async () => {
            const result = await controller.transcribe(
                'audio/meeting1.mp3',
                '' as any,
                ''
            );

            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain('required');
        });

        it('should call progress callback during transcription', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Test transcript'
            });

            const progressCallback = vi.fn();

            await controller.transcribe(
                'audio/meeting1.mp3',
                'openai',
                'test-api-key',
                progressCallback
            );

            expect(progressCallback).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.any(String) })
            );
        });

        it('should call progress callback during chunked transcription', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: true });
            (compressAndChunkAudio as Mock).mockImplementation(async (app, file, callback) => {
                callback({ progress: 50 });
                return {
                    success: true,
                    chunks: ['chunk1.mp3'],
                    outputDir: '/tmp'
                };
            });
            (transcribeChunkedAudioWithCleanup as Mock).mockImplementation(
                async (chunks, dir, opts, callback) => {
                    callback({ currentChunk: 0, totalChunks: 1, globalPercent: 100 });
                    return { success: true, transcript: 'Test' };
                }
            );

            const progressCallback = vi.fn();

            await controller.transcribe(
                'audio/meeting1.mp3',
                'openai',
                'test-api-key',
                progressCallback
            );

            expect(progressCallback).toHaveBeenCalled();
            expect(progressCallback.mock.calls.some(call =>
                call[0].message.includes('Compressing')
            )).toBe(true);
            expect(progressCallback.mock.calls.some(call =>
                call[0].message.includes('Transcribing chunk')
            )).toBe(true);
        });

        it('should set isTranscribing flag during transcription', async () => {
            let capturedDuringTranscription = false;

            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockImplementation(async () => {
                // Check state during transcription
                const item = controller.getItem('audio/meeting1.mp3');
                capturedDuringTranscription = item?.isTranscribing || false;

                return { success: true, transcript: 'Test' };
            });

            await controller.transcribe(
                'audio/meeting1.mp3',
                'openai',
                'test-api-key'
            );

            expect(capturedDuringTranscription).toBe(true);

            // After transcription
            const item = controller.getItem('audio/meeting1.mp3');
            expect(item?.isTranscribing).toBe(false);
        });
    });

    // === Batch Transcription Tests ===

    describe('Batch Transcription', () => {
        beforeEach(() => {
            // Add multiple items
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                },
                {
                    type: 'audio',
                    displayName: 'meeting2.m4a',
                    resolvedFile: mockFile2
                }
            ]);

            controller.addDetectedFromContent('content');
        });

        it('should transcribe all items', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock)
                .mockResolvedValueOnce({ success: true, transcript: 'Transcript 1' })
                .mockResolvedValueOnce({ success: true, transcript: 'Transcript 2' });

            const result = await controller.transcribeAll('openai', 'test-api-key');

            expect(result.errors).toEqual([]);
            expect(result.value?.size).toBe(2);
            expect(result.value?.get('audio/meeting1.mp3')).toBe('Transcript 1');
            expect(result.value?.get('audio/meeting2.m4a')).toBe('Transcript 2');
        });

        it('should skip items with existing transcripts', async () => {
            // Transcribe first item
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Transcript 1'
            });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'test-api-key');

            // Now transcribe all - should only transcribe second item
            vi.clearAllMocks();
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Transcript 2'
            });

            await controller.transcribeAll('openai', 'test-api-key');

            expect(transcribeAudio).toHaveBeenCalledTimes(1);
        });

        it('should collect errors from failed transcriptions', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock)
                .mockResolvedValueOnce({ success: true, transcript: 'Transcript 1' })
                .mockResolvedValueOnce({ success: false, error: 'API error' });

            const result = await controller.transcribeAll('openai', 'test-api-key');

            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain('meeting2.m4a');
            expect(result.errors[0]).toContain('API error');
            expect(result.value?.size).toBe(1);
        });

        it('should call progress callback for batch', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Test'
            });

            const progressCallback = vi.fn();

            await controller.transcribeAll('openai', 'test-api-key', progressCallback);

            expect(progressCallback).toHaveBeenCalled();
            expect(progressCallback.mock.calls.some(call =>
                call[0].message.includes('[1/2]')
            )).toBe(true);
            expect(progressCallback.mock.calls.some(call =>
                call[0].message.includes('[2/2]')
            )).toBe(true);
        });

        it('should return empty result when no items to transcribe', async () => {
            controller.clear();

            const result = await controller.transcribeAll('openai', 'test-api-key');

            expect(result.errors).toEqual([]);
            expect(result.value?.size).toBe(0);
        });
    });

    // === Query Tests ===

    describe('Query Methods', () => {
        beforeEach(() => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                },
                {
                    type: 'audio',
                    displayName: 'meeting2.m4a',
                    resolvedFile: mockFile2
                }
            ]);

            controller.addDetectedFromContent('content');
        });

        it('should get combined transcripts', async () => {
            // Transcribe both items
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock)
                .mockResolvedValueOnce({ success: true, transcript: 'Transcript 1' })
                .mockResolvedValueOnce({ success: true, transcript: 'Transcript 2' });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');
            await controller.transcribe('audio/meeting2.m4a', 'openai', 'key');

            const combined = controller.getCombinedTranscripts();
            expect(combined).toBe('Transcript 1\n\nTranscript 2');
        });

        it('should use custom separator for combined transcripts', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock)
                .mockResolvedValueOnce({ success: true, transcript: 'A' })
                .mockResolvedValueOnce({ success: true, transcript: 'B' });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');
            await controller.transcribe('audio/meeting2.m4a', 'openai', 'key');

            const combined = controller.getCombinedTranscripts(' | ');
            expect(combined).toBe('A | B');
        });

        it('should return empty string when no transcripts', () => {
            const combined = controller.getCombinedTranscripts();
            expect(combined).toBe('');
        });

        it('should get transcribed items', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Test'
            });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');

            const transcribed = controller.getTranscribedItems();
            expect(transcribed.length).toBe(1);
            expect(transcribed[0].id).toBe('audio/meeting1.mp3');
        });

        it('should get pending items', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: true,
                transcript: 'Test'
            });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');

            const pending = controller.getPendingItems();
            expect(pending.length).toBe(1);
            expect(pending[0].id).toBe('audio/meeting2.m4a');
        });

        it('should get failed items', async () => {
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: false,
                error: 'Error'
            });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');

            const failed = controller.getFailedItems();
            expect(failed.length).toBe(1);
            expect(failed[0].id).toBe('audio/meeting1.mp3');
            expect(failed[0].error).toBe('Error');
        });

        it('should check if any transcribing', async () => {
            expect(controller.isAnyTranscribing()).toBe(false);

            // Mock slow transcription
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                return { success: true, transcript: 'Test' };
            });

            const promise = controller.transcribe('audio/meeting1.mp3', 'openai', 'key');
            
            // Check during transcription
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(controller.isAnyTranscribing()).toBe(true);

            await promise;
            expect(controller.isAnyTranscribing()).toBe(false);
        });
    });

    // === Item Management Tests ===

    describe('Item Management', () => {
        beforeEach(() => {
            (detectEmbeddedAudio as Mock).mockReturnValue([
                {
                    type: 'audio',
                    displayName: 'meeting1.mp3',
                    resolvedFile: mockFile1
                }
            ]);

            controller.addDetectedFromContent('content');
        });

        it('should reset item state', async () => {
            // Transcribe with error
            (needsChunking as Mock).mockResolvedValue({ needsChunking: false });
            (transcribeAudio as Mock).mockResolvedValue({
                success: false,
                error: 'Error'
            });

            await controller.transcribe('audio/meeting1.mp3', 'openai', 'key');

            const itemBefore = controller.getItem('audio/meeting1.mp3');
            expect(itemBefore?.error).toBe('Error');

            // Reset
            const result = controller.resetItem('audio/meeting1.mp3');
            expect(result).toBe(true);

            const itemAfter = controller.getItem('audio/meeting1.mp3');
            expect(itemAfter?.error).toBeUndefined();
            expect(itemAfter?.transcript).toBeUndefined();
            expect(itemAfter?.isTranscribing).toBe(false);
        });

        it('should return false when resetting non-existent item', () => {
            const result = controller.resetItem('nonexistent.mp3');
            expect(result).toBe(false);
        });

        it('should remove item', () => {
            expect(controller.getCount()).toBe(1);

            const result = controller.removeItem('audio/meeting1.mp3');
            expect(result).toBe(true);
            expect(controller.getCount()).toBe(0);
        });

        it('should return false when removing non-existent item', () => {
            const result = controller.removeItem('nonexistent.mp3');
            expect(result).toBe(false);
            expect(controller.getCount()).toBe(1);
        });
    });
});
