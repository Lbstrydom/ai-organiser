/**
 * AudioController
 * Manages audio file detection and transcription state for UI components
 * 
 * Responsibilities:
 * - Track detected audio files with transcription state
 * - Delegate transcription to AudioTranscriptionService
 * - Provide immutable access to audio items
 * - Surface transcription errors via result objects
 * 
 * Design:
 * - No direct modal/UI coupling
 * - Errors returned, not thrown (except programmer misuse)
 * - State updates during async operations
 * - ID-based lookup using file path
 */

import { App, TFile } from 'obsidian';
import { DetectedContent, detectEmbeddedAudio } from '../../utils/embeddedContentDetector';
import { TranscriptionProvider } from '../../services/audioTranscriptionService';

export interface AudioItem {
    id: string; // TFile path for stable identity
    file: TFile;
    displayName: string;
    transcript?: string;
    isTranscribing: boolean;
    error?: string;
}

export interface AudioResult<T> {
    value?: T;
    errors: string[];
}

export interface TranscriptionProgress {
    message: string;
    percent?: number;
}

export type ProgressCallback = (progress: TranscriptionProgress) => void;

/**
 * AudioController
 * Manages audio file state and transcription operations
 * 
 * Usage:
 * ```typescript
 * const controller = new AudioController(app);
 * 
 * // Detect from note content
 * controller.addDetectedFromContent(content, currentFile);
 * 
 * // Transcribe
 * const result = await controller.transcribe(audioId, provider, apiKey);
 * if (result.errors.length > 0) {
 *     // Handle errors
 * }
 * 
 * // Get all items (immutable)
 * const items = controller.getItems();
 * ```
 * 
 * Known Limitations:
 * - No cancellation support for in-progress transcriptions
 * - Constructor accepts App instead of AIOrganiserPlugin (follows ISP)
 * - TFile references are shared (immutable by Obsidian contract)
 */
export class AudioController {
    private app: App;
    private audioItems: AudioItem[] = [];

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Get all audio items (shallow copy)
     * Returns copies of items to prevent mutation
     * Note: TFile references are shared (immutable by Obsidian contract)
     */
    getItems(): AudioItem[] {
        return this.audioItems.map(item => ({ ...item }));
    }

    /**
     * Get item count
     */
    getCount(): number {
        return this.audioItems.length;
    }

    /**
     * Get a single item by ID (immutable copy)
     * Returns null if not found
     */
    getItem(id: string): AudioItem | null {
        const item = this.audioItems.find(a => a.id === id);
        return item ? { ...item } : null;
    }

    /**
     * Clear all audio items
     */
    clear(): void {
        this.audioItems = [];
    }

    /**
     * Detect embedded audio from content (read-only, no state change)
     * Returns detected items without adding to internal state
     * Use addDetectedFromContent() to detect and add in one step
     */
    detectFromContent(content: string, currentFile?: TFile): AudioItem[] {
        const detectedContent = detectEmbeddedAudio(this.app, content, currentFile);
        return this.convertToAudioItems(detectedContent);
    }

    /**
     * Detect and add audio files from content to internal state
     * Automatically deduplicates by file path
     */
    addDetectedFromContent(content: string, currentFile?: TFile): void {
        const detected = this.detectFromContent(content, currentFile);
        this.addItems(detected);
    }

    /**
     * Add audio items with deduplication
     * Items with same ID (file path) are skipped
     */
    private addItems(items: AudioItem[]): void {
        for (const item of items) {
            // Dedupe by ID
            if (!this.audioItems.some(a => a.id === item.id)) {
                this.audioItems.push(item);
            }
        }
    }

    /**
     * Convert DetectedContent to AudioItem
     * Only includes items with resolved files
     */
    private convertToAudioItems(detected: DetectedContent[]): AudioItem[] {
        const items: AudioItem[] = [];
        
        for (const content of detected) {
            if (!content.resolvedFile) {
                continue; // Skip unresolved files
            }
            
            items.push({
                id: content.resolvedFile.path,
                file: content.resolvedFile,
                displayName: content.displayName,
                transcript: undefined,
                isTranscribing: false,
                error: undefined
            });
        }
        
        return items;
    }

    /**
     * Check if any audio file is currently transcribing
     */
    isAnyTranscribing(): boolean {
        return this.audioItems.some(item => item.isTranscribing);
    }

    /**
     * Get transcription status message
     * Returns display name of first transcribing item, or empty string
     */
    getTranscriptionStatus(): string {
        const transcribing = this.audioItems.find(item => item.isTranscribing);
        return transcribing ? `Transcribing ${transcribing.displayName}...` : '';
    }

    /**
     * Transcribe a single audio file
     * Updates item state during transcription
     * 
     * @param itemId - Audio item ID (file path)
     * @param provider - Transcription provider ('openai' | 'groq')
     * @param apiKey - API key for provider
     * @param onProgress - Optional progress callback
     * @returns AudioResult with transcript or errors
     */
    async transcribe(
        itemId: string,
        provider: TranscriptionProvider,
        apiKey: string,
        onProgress?: ProgressCallback
    ): Promise<AudioResult<string>> {
        // Find item
        const item = this.audioItems.find(a => a.id === itemId);
        if (!item) {
            return { errors: [`Audio item not found: ${itemId}`] };
        }

        // Validate provider
        if (!provider || !apiKey) {
            return { errors: ['Provider and API key are required'] };
        }

        // Set transcribing state
        item.isTranscribing = true;
        item.error = undefined;

        try {
            // Dynamically import transcription service to avoid circular deps
            const audioService = await import('../../services/audioTranscriptionService');
            const compressionService = await import('../../services/audioCompressionService');
            
            if (!audioService.transcribeAudio || !audioService.transcribeChunkedAudioWithCleanup) {
                throw new Error('Audio transcription service not available');
            }
            if (!compressionService.needsChunking || !compressionService.compressAndChunkAudio) {
                throw new Error('Audio compression service not available');
            }
            
            const { transcribeAudio, transcribeChunkedAudioWithCleanup } = audioService;
            const { needsChunking, compressAndChunkAudio } = compressionService;

            const file = item.file;
            const chunkCheck = await needsChunking(this.app, file);

            let transcript: string;

            if (chunkCheck.needsChunking) {
                // Chunked transcription for long audio
                const chunkResult = await compressAndChunkAudio(this.app, file, (progress) => {
                    const message = `Compressing: ${Math.round(progress.progress)}%`;
                    if (onProgress) {
                        onProgress({ message, percent: progress.progress });
                    }
                });

                if (!chunkResult.success || !chunkResult.chunks || !chunkResult.outputDir) {
                    throw new Error(chunkResult.error || 'Failed to prepare audio chunks');
                }

                const transcriptResult = await transcribeChunkedAudioWithCleanup(
                    chunkResult.chunks,
                    chunkResult.outputDir,
                    {
                        provider: provider,
                        apiKey: apiKey
                    },
                    (progress) => {
                        const message = `Transcribing chunk ${progress.currentChunk + 1}/${progress.totalChunks} (${Math.round(progress.globalPercent)}%)`;
                        if (onProgress) {
                            onProgress({ message, percent: progress.globalPercent });
                        }
                    }
                );

                if (!transcriptResult.success || !transcriptResult.transcript) {
                    throw new Error(transcriptResult.error || 'Transcription failed');
                }
                transcript = transcriptResult.transcript;
            } else {
                // Direct transcription
                if (onProgress) {
                    onProgress({ message: 'Transcribing...' });
                }

                const result = await transcribeAudio(this.app, file, {
                    provider: provider,
                    apiKey: apiKey
                });

                if (!result.success || !result.transcript) {
                    throw new Error(result.error || 'Transcription failed');
                }
                transcript = result.transcript;
            }

            // Update item with transcript
            item.transcript = transcript;
            item.isTranscribing = false;
            item.error = undefined;

            return { value: transcript, errors: [] };

        } catch (error) {
            // Update item with error
            const message = error instanceof Error ? error.message : 'Unknown transcription error';
            item.isTranscribing = false;
            item.error = message;

            return { errors: [message] };
        }
    }

    /**
     * Transcribe all audio files that don't have transcripts
     * Skips files that already have transcripts or errors
     * Processes sequentially to avoid API rate limits
     * 
     * @param provider - Transcription provider ('openai' | 'groq')
     * @param apiKey - API key for provider
     * @param onProgress - Optional progress callback
     * @returns AudioResult with map of itemId -> transcript
     * @remarks Items with errors are skipped. Call resetItem(id) to clear errors before retry.
     */
    async transcribeAll(
        provider: TranscriptionProvider,
        apiKey: string,
        onProgress?: ProgressCallback
    ): Promise<AudioResult<Map<string, string>>> {
        const transcripts = new Map<string, string>();
        const errors: string[] = [];

        // Filter items that need transcription
        const itemsToTranscribe = this.audioItems.filter(
            item => !item.transcript && !item.isTranscribing && !item.error
        );

        if (itemsToTranscribe.length === 0) {
            return { value: transcripts, errors: [] };
        }

        // Transcribe sequentially
        for (let i = 0; i < itemsToTranscribe.length; i++) {
            const item = itemsToTranscribe[i];
            
            // Progress callback for overall progress
            const itemProgress: ProgressCallback = (progress) => {
                if (onProgress) {
                    const message = `[${i + 1}/${itemsToTranscribe.length}] ${item.displayName}: ${progress.message}`;
                    const percent = ((i / itemsToTranscribe.length) * 100) + ((progress.percent || 0) / itemsToTranscribe.length);
                    onProgress({ message, percent });
                }
            };

            const result = await this.transcribe(item.id, provider, apiKey, itemProgress);

            if (result.errors.length > 0) {
                errors.push(`${item.displayName}: ${result.errors.join(', ')}`);
            } else if (result.value) {
                transcripts.set(item.id, result.value);
            }
        }

        return { value: transcripts, errors };
    }

    /**
     * Get combined transcripts from all items
     * Joins transcripts in order with separator
     * Skips items without transcripts
     * 
     * @param separator - Separator between transcripts (default: double newline)
     * @returns Combined transcript text
     */
    getCombinedTranscripts(separator: string = '\n\n'): string {
        const transcripts = this.audioItems
            .filter(item => item.transcript)
            .map(item => item.transcript as string);

        return transcripts.join(separator);
    }

    /**
     * Get items with transcripts
     */
    getTranscribedItems(): AudioItem[] {
        return this.audioItems
            .filter(item => item.transcript)
            .map(item => ({ ...item }));
    }

    /**
     * Get items without transcripts (pending)
     */
    getPendingItems(): AudioItem[] {
        return this.audioItems
            .filter(item => !item.transcript && !item.error)
            .map(item => ({ ...item }));
    }

    /**
     * Get items with errors
     */
    getFailedItems(): AudioItem[] {
        return this.audioItems
            .filter(item => item.error)
            .map(item => ({ ...item }));
    }

    /**
     * Reset transcription state for an item
     * Clears transcript, error, and transcribing flag
     * Useful for retrying failed transcriptions
     */
    resetItem(itemId: string): boolean {
        const item = this.audioItems.find(a => a.id === itemId);
        if (!item) {
            return false;
        }

        item.transcript = undefined;
        item.error = undefined;
        item.isTranscribing = false;
        return true;
    }

    /**
     * Remove an item by ID
     * Returns true if item was found and removed
     */
    removeItem(itemId: string): boolean {
        const index = this.audioItems.findIndex(a => a.id === itemId);
        if (index === -1) {
            return false;
        }

        this.audioItems.splice(index, 1);
        return true;
    }
}
