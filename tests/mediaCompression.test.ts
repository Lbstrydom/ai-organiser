/**
 * Media Compression Tests — Phase 5
 * Tests for compression offer logic, extension mapping, replacement utilities,
 * and exact-slice buffer safety.
 */
import { vi } from 'vitest';
import { ImageProcessorService } from '../src/services/imageProcessorService';
import { shouldOfferCompression } from '../src/commands/digitisationCommands';
import { replaceAudioFile } from '../src/services/audioCompressionService';
import type { TranscriptionResult } from '../src/services/audioTranscriptionService';
import type { ProcessedImage } from '../src/services/imageProcessorService';
import { createTFile } from './mocks/obsidian';

// Mock App for ImageProcessorService constructor
const mockApp = {} as any;

// ============================================================================
// ImageProcessorService.mediaTypeToExtension
// ============================================================================

describe('ImageProcessorService.mediaTypeToExtension', () => {
    const service = new ImageProcessorService(mockApp);

    it('maps image/jpeg to jpg', () => {
        expect(service.mediaTypeToExtension('image/jpeg')).toBe('jpg');
    });

    it('maps image/png to png', () => {
        expect(service.mediaTypeToExtension('image/png')).toBe('png');
    });

    it('maps image/webp to webp', () => {
        expect(service.mediaTypeToExtension('image/webp')).toBe('webp');
    });

    it('maps image/gif to gif', () => {
        expect(service.mediaTypeToExtension('image/gif')).toBe('gif');
    });

    it('returns null for unknown media type', () => {
        expect(service.mediaTypeToExtension('image/bmp')).toBeNull();
    });

    it('returns null for non-image media type', () => {
        expect(service.mediaTypeToExtension('audio/mp3')).toBeNull();
    });
});

// ============================================================================
// shouldOfferCompression (real export from digitisationCommands)
// ============================================================================

describe('shouldOfferCompression', () => {
    function makePlugin(setting: 'always' | 'large-files' | 'never', threshold = 5_000_000) {
        return {
            settings: {
                offerMediaCompression: setting,
                mediaCompressionThreshold: threshold
            }
        } as any;
    }

    function makeFile(sizeBytes: number) {
        const file = createTFile('audio/test.wav');
        (file as any).stat = { size: sizeBytes };
        return file;
    }

    function makeProcessed(original: number, processed: number, hasBlob: boolean): ProcessedImage {
        return {
            base64: '',
            mediaType: 'image/jpeg',
            width: 100,
            height: 100,
            originalSizeBytes: original,
            processedSizeBytes: processed,
            wasConverted: false,
            wasResized: false,
            replacementBlob: hasBlob ? new ArrayBuffer(processed) : undefined
        };
    }

    it('returns false when setting is never', () => {
        expect(shouldOfferCompression(
            makePlugin('never'), makeFile(10_000_000), makeProcessed(10_000_000, 2_000_000, true)
        )).toBe(false);
    });

    it('returns true when setting is always and savings > 10%', () => {
        expect(shouldOfferCompression(
            makePlugin('always'), makeFile(1_000), makeProcessed(10_000_000, 2_000_000, true)
        )).toBe(true);
    });

    it('returns false when savings < 10%', () => {
        expect(shouldOfferCompression(
            makePlugin('always'), makeFile(10_000_000), makeProcessed(10_000_000, 9_500_000, true)
        )).toBe(false);
    });

    it('returns false when no replacement blob', () => {
        expect(shouldOfferCompression(
            makePlugin('always'), makeFile(10_000_000), makeProcessed(10_000_000, 2_000_000, false)
        )).toBe(false);
    });

    it('returns true for large-files when file exceeds threshold', () => {
        expect(shouldOfferCompression(
            makePlugin('large-files'), makeFile(10_000_000), makeProcessed(10_000_000, 2_000_000, true)
        )).toBe(true);
    });

    it('returns false for large-files when file is under threshold', () => {
        expect(shouldOfferCompression(
            makePlugin('large-files'), makeFile(3_000_000), makeProcessed(10_000_000, 2_000_000, true)
        )).toBe(false);
    });

    it('returns false when savings exactly 10% (edge case)', () => {
        // 10% savings means processedSize = 90% of original → savingsPercent = 0.1, not > 0.1
        expect(shouldOfferCompression(
            makePlugin('always'), makeFile(10_000_000), makeProcessed(10_000_000, 9_000_000, true)
        )).toBe(false);
    });
});

// ============================================================================
// replaceAudioFile — exact-bytes and rename/backlink behavior
// ============================================================================

// Mock minutesUtils.getAvailableFilePath (used by replaceAudioFile)
vi.mock('../src/utils/minutesUtils', () => ({
    getAvailableFilePath: vi.fn(async (_vault: any, dir: string, fileName: string) => {
        return dir ? `${dir}/${fileName}` : fileName;
    })
}));

describe('replaceAudioFile', () => {
    function buildMockApp(resolvedLinks: Record<string, Record<string, number>> = {}) {
        const modifyBinary = vi.fn().mockResolvedValue(undefined);
        const renameFile = vi.fn().mockResolvedValue(undefined);
        const getAbstractFileByPath = vi.fn((path: string) => {
            const f = createTFile(path);
            return f;
        });

        return {
            vault: {
                modifyBinary,
                getAbstractFileByPath
            },
            fileManager: { renameFile },
            metadataCache: { resolvedLinks }
        } as any;
    }

    it('writes exact-slice buffer (not raw .buffer)', async () => {
        const app = buildMockApp();
        const file = createTFile('audio/test.mp3');
        (file as any).extension = 'mp3';
        (file as any).basename = 'test';
        (file as any).parent = { path: 'audio' };

        // Create a Uint8Array as a SUBARRAY of a larger buffer to simulate the corruption risk
        const backingBuffer = new ArrayBuffer(100);
        const view = new Uint8Array(backingBuffer, 10, 5); // offset=10, length=5
        view.set([1, 2, 3, 4, 5]);

        await replaceAudioFile(app, file, view, 'mp3');

        // modifyBinary should receive a buffer of exactly 5 bytes, not 100
        const writtenBuffer = app.vault.modifyBinary.mock.calls[0][1] as ArrayBuffer;
        expect(writtenBuffer.byteLength).toBe(5);

        // Verify the content is correct
        const written = new Uint8Array(writtenBuffer);
        expect(Array.from(written)).toEqual([1, 2, 3, 4, 5]);
    });

    it('calls renameFile when extension changes', async () => {
        const app = buildMockApp();
        const file = createTFile('audio/recording.wav');
        (file as any).extension = 'wav';
        (file as any).basename = 'recording';
        (file as any).parent = { path: 'audio' };

        const data = new Uint8Array([1, 2, 3]);
        await replaceAudioFile(app, file, data, 'mp3');

        expect(app.fileManager.renameFile).toHaveBeenCalledWith(file, 'audio/recording.mp3');
    });

    it('does NOT call renameFile when extension matches', async () => {
        const app = buildMockApp();
        const file = createTFile('audio/recording.mp3');
        (file as any).extension = 'mp3';
        (file as any).basename = 'recording';
        (file as any).parent = { path: 'audio' };

        const data = new Uint8Array([1, 2, 3]);
        await replaceAudioFile(app, file, data, 'mp3');

        expect(app.fileManager.renameFile).not.toHaveBeenCalled();
    });

    it('counts backlinksMigrated from resolvedLinks', async () => {
        const resolvedLinks = {
            'notes/note1.md': { 'audio/recording.mp3': 1 },
            'notes/note2.md': { 'audio/recording.mp3': 2 },
            'notes/note3.md': { 'other/file.md': 1 }
        };
        const app = buildMockApp(resolvedLinks);
        const file = createTFile('audio/recording.mp3');
        (file as any).extension = 'mp3';
        (file as any).basename = 'recording';
        (file as any).parent = { path: 'audio' };

        const data = new Uint8Array([1, 2, 3]);
        const result = await replaceAudioFile(app, file, data, 'mp3');

        // 2 files link to 'audio/recording.mp3'
        expect(result.backlinksMigrated).toBe(2);
    });
});

// ============================================================================
// CompressionConfirmModal formatBytes (utility pattern test)
// ============================================================================

describe('CompressionConfirmModal formatBytes', () => {
    // Test the formatBytes utility pattern used in both CompressionConfirmModal and ImageProcessorService
    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    it('formats 0 bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes', () => {
        expect(formatBytes(500)).toBe('500.0 B');
    });

    it('formats kilobytes', () => {
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats megabytes', () => {
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('formats gigabytes', () => {
        expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });
});

// ============================================================================
// TranscriptionResult compression data threading
// ============================================================================

describe('TranscriptionResult compression data threading', () => {
    it('TranscriptionResult interface supports compressed data fields', () => {
        const result: TranscriptionResult = {
            success: true,
            transcript: 'Hello world',
            compressedData: new Uint8Array([1, 2, 3]),
            originalSizeBytes: 50_000_000
        };

        expect(result.compressedData).toBeInstanceOf(Uint8Array);
        expect(result.originalSizeBytes).toBe(50_000_000);
    });

    it('TranscriptionResult works without compression fields', () => {
        const result: TranscriptionResult = {
            success: true,
            transcript: 'Hello world'
        };

        expect(result.compressedData).toBeUndefined();
        expect(result.originalSizeBytes).toBeUndefined();
    });
});
