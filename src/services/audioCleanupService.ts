/**
 * Post-transcription audio file cleanup.
 * Offers keep-original / replace-with-compressed / delete options
 * after any audio transcription path (standalone, multi-source, minutes).
 *
 * Respects the `postRecordingStorage` user setting.
 */
import { Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { CompressionAction } from '../ui/modals/CompressionConfirmModal';
import type { TranscriptionResult } from './audioTranscriptionService';
import { logger } from '../utils/logger';

export interface AudioCleanupOptions {
    /** The vault file that was transcribed */
    file: TFile;
    /** Transcription result (may contain compressedData from workflow) */
    transcriptionResult: Pick<TranscriptionResult, 'compressedData' | 'originalSizeBytes'>;
}

/**
 * Offer the user post-transcription cleanup options for an audio file.
 *
 * Behaviour per `postRecordingStorage` setting:
 * - `'ask'`            → show 3-option modal (keep / compress / delete)
 * - `'keep-original'`  → no-op
 * - `'keep-compressed'` → auto-replace if compressed data available
 * - `'delete'`         → auto-delete file
 */
export async function offerPostTranscriptionCleanup(
    plugin: AIOrganiserPlugin,
    options: AudioCleanupOptions
): Promise<CompressionAction> {
    const { file, transcriptionResult } = options;
    const policy = plugin.settings.postRecordingStorage || 'ask';

    if (policy === 'keep-original') return 'keep-original';

    const hasCompressed = !!(
        transcriptionResult.compressedData &&
        transcriptionResult.originalSizeBytes &&
        transcriptionResult.originalSizeBytes > 0
    );

    // Check minimum savings threshold (>10%) before offering compression
    const worthCompressing = hasCompressed &&
        (1 - transcriptionResult.compressedData!.byteLength / transcriptionResult.originalSizeBytes!) > 0.1;

    // Auto-policies
    if (policy === 'keep-compressed') {
        if (worthCompressing) {
            await replaceWithCompressed(plugin, file, transcriptionResult);
            return 'keep-compressed';
        }
        return 'keep-original'; // Nothing to compress
    }

    if (policy === 'delete') {
        await deleteAudioFile(plugin, file);
        return 'delete';
    }

    // policy === 'ask' → show modal
    const { CompressionConfirmModal } = await import('../ui/modals/CompressionConfirmModal');
    const modal = new CompressionConfirmModal(
        plugin,
        file.stat.size,
        worthCompressing ? transcriptionResult.compressedData!.byteLength : undefined,
        file.name,
        worthCompressing && file.extension.toLowerCase() !== 'mp3'
    );
    modal.open();
    const choice = await modal.waitForChoice();

    // Execute the chosen action
    if (choice.action === 'keep-compressed' && worthCompressing) {
        await replaceWithCompressed(plugin, file, transcriptionResult);
    } else if (choice.action === 'delete') {
        await deleteAudioFile(plugin, file);
    }

    return choice.action;
}

/** Replace an audio file with its compressed version (backlink-safe). */
async function replaceWithCompressed(
    plugin: AIOrganiserPlugin,
    file: TFile,
    transcriptionResult: Pick<TranscriptionResult, 'compressedData' | 'originalSizeBytes'>
): Promise<void> {
    if (!transcriptionResult.compressedData) return;

    try {
        const { replaceAudioFile } = await import('./audioCompressionService');
        const result = await replaceAudioFile(plugin.app, file, transcriptionResult.compressedData, 'mp3');
        const t = plugin.t.compression;
        const msg = result.backlinksMigrated > 0
            ? `${t?.replaceSuccess || 'File replaced'} (${(t?.backlinksMigrated || '{n} backlinks updated').replace('{n}', String(result.backlinksMigrated))})`
            : t?.replaceSuccess || 'File replaced successfully';
        new Notice(msg);
    } catch (err) {
        logger.error('Audio', 'Replace failed:', err);
        new Notice(plugin.t.compression?.replaceFailed || 'Failed to replace file');
    }
}

/** Delete an audio file from the vault. */
async function deleteAudioFile(
    plugin: AIOrganiserPlugin,
    file: TFile
): Promise<void> {
    try {
        await plugin.app.fileManager.trashFile(file);
        new Notice(plugin.t.compression?.audioDeleted || 'Audio file deleted');
    } catch (err) {
        logger.error('Audio', 'Delete failed:', err);
        new Notice('Failed to delete audio file');
    }
}
