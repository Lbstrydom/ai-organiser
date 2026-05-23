/**
 * Vault persistence for non-vault audio sources (plan §1.5, R2 H2).
 *
 * Normalises every `AudioSource` kind into a vault `TFile` so that downstream
 * services (`AudioController`, `audioTranscriptionService`) keep their existing
 * `TFile`-based signatures unchanged. Without this, the new desktop / mobile /
 * recorder source kinds introduced by `AudioSourcePicker` cannot reach the
 * transcription pipeline.
 *
 * Per-kind behaviour:
 *  - `vault`         → returns the existing `TFile` unchanged; `imported = false`.
 *  - `desktop-path`  → reads via `fs.promises.readFile`, writes to vault.
 *  - `webview-blob`  → reads via `Blob.arrayBuffer()`, writes to vault.
 *  - `recorder`      → same as `webview-blob`; default subfolder differs
 *                      (`Recordings/` to match the existing recorder flow).
 *
 * Collision handling: reuses `getAvailableFilePath` from minutesUtils for
 * consistent `(2)`, `(3)`, ... suffixing across the codebase.
 *
 * MIME validation: whitelist of `audio/*` MIME types per `AUDIO_MIME_WHITELIST`.
 * `application/octet-stream` is allowed when the extension itself is on the
 * audio whitelist (some browsers don't tag File.type for `.m4a`).
 *
 * Abort handling: optional `AbortSignal`. When aborted DURING write, the
 * partially-written file is trashed via `fileManager.trashFile()` (per the
 * Obsidian review-bot rule).
 */

import type { App, TFile } from 'obsidian';
import { normalizePath } from 'obsidian';
import type { AudioSource } from '../../ui/components/speakerReviewState';
import {
    AUDIO_EXTENSIONS,
    guessMimeFromExtension,
} from '../../ui/utils/AudioSourcePicker';
import { ensureFolderExists, getAvailableFilePath, sanitizeFileName } from '../../utils/minutesUtils';
import { getFs } from '../../utils/desktopRequire';
import { logger } from '../../utils/logger';
import type { Result } from '../../core/result';

// ============================================================================
// Public contract
// ============================================================================

/**
 * Outcome of `importAudioToVault`. The `imported` flag distinguishes a
 * newly-written vault file from a passthrough of an existing one (vault
 * sources). Useful for cleanup decisions later (only delete imports the
 * user actually opted into).
 */
export interface ImportedAudio {
    /** Always a vault file after `importAudioToVault()` resolves successfully */
    file: TFile;
    /** The source kind we started from */
    origin: AudioSource['kind'];
    /** Original display name before vault-path normalisation */
    originalName: string;
    /** True when this call created a new vault file (vs reused existing) */
    imported: boolean;
}

export interface ImportOptions {
    /** Vault-relative folder for new files. Created if missing. */
    targetFolder: string;
    /** Cancel an in-progress write. */
    signal?: AbortSignal;
}

/**
 * Persist any `AudioSource` to the vault and return a `TFile` reference.
 * Idempotent for vault sources.
 *
 * Errors returned (never thrown):
 *  - `unsupported-mime`         — MIME or extension not in the audio whitelist
 *  - `desktop-fs-unavailable`   — getFs() returned undefined (mobile + desktop-path)
 *  - `aborted`                  — caller's AbortSignal triggered
 *  - `vault-write-failed`       — vault.createBinary rejected
 *  - `read-failed`              — fs.readFile or blob.arrayBuffer rejected
 */
export async function importAudioToVault(
    app: App,
    source: AudioSource,
    options: ImportOptions
): Promise<Result<ImportedAudio>> {
    if (source.kind === 'vault') {
        return {
            ok: true,
            value: {
                file: source.file,
                origin: 'vault',
                originalName: source.file.name,
                imported: false,
            },
        };
    }

    if (options.signal?.aborted) {
        return { ok: false, error: 'aborted' };
    }

    // Validate MIME/extension before any read.
    const mimeCheck = validateAudioMime(source);
    if (!mimeCheck.ok) return mimeCheck;

    // Read bytes per kind.
    const readResult = await readSourceBytes(source, options.signal);
    if (!readResult.ok) return readResult;

    if (options.signal?.aborted) {
        return { ok: false, error: 'aborted' };
    }

    // Resolve target path with collision-safe suffix.
    const sanitized = sanitizeFileName(getOriginalName(source));
    const targetFolder = normalizePath(options.targetFolder);
    try {
        await ensureFolderExists(app.vault, targetFolder);
    } catch (e) {
        logger.warn('AudioImport', `ensureFolderExists failed: ${String(e)}`);
        return { ok: false, error: 'vault-write-failed' };
    }
    const targetPath = await getAvailableFilePath(app.vault, targetFolder, sanitized);

    // Write.
    let file: TFile;
    try {
        file = await app.vault.createBinary(targetPath, readResult.value);
    } catch (e) {
        logger.warn('AudioImport', `vault.createBinary failed: ${String(e)}`);
        return { ok: false, error: 'vault-write-failed' };
    }

    if (options.signal?.aborted) {
        // Best-effort cleanup of the partial write per Obsidian review-bot rule.
        try {
            await app.fileManager.trashFile(file);
        } catch (e) {
            logger.warn('AudioImport', `trashFile after abort failed: ${String(e)}`);
        }
        return { ok: false, error: 'aborted' };
    }

    return {
        ok: true,
        value: {
            file,
            origin: source.kind,
            originalName: getOriginalName(source),
            imported: true,
        },
    };
}

// ============================================================================
// MIME whitelist
// ============================================================================

const AUDIO_MIME_WHITELIST: ReadonlySet<string> = new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/webm',
    'audio/ogg',
    'audio/flac',
    'audio/x-flac',
]);

const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);

function validateAudioMime(
    source: Exclude<AudioSource, { kind: 'vault' }>
): Result<true> {
    const mime = sourceMime(source);
    const ext = sourceExtension(source);
    const mimeOk = AUDIO_MIME_WHITELIST.has(mime.toLowerCase());
    const extOk = AUDIO_EXTENSION_SET.has(ext.toLowerCase());

    // Accept octet-stream if the extension itself is whitelisted (Firefox
    // sometimes drops File.type for .m4a; some Electron dialogs don't tag
    // desktop paths at all — extension is the only signal).
    const isOctet = mime.toLowerCase() === 'application/octet-stream' || mime === '';
    if (isOctet && extOk) return { ok: true, value: true };

    if (!mimeOk && !extOk) {
        logger.warn('AudioImport', `rejected unsupported audio mime=${mime} ext=${ext}`);
        return { ok: false, error: 'unsupported-mime' };
    }
    return { ok: true, value: true };
}

function sourceMime(source: Exclude<AudioSource, { kind: 'vault' }>): string {
    switch (source.kind) {
        case 'desktop-path':
            return guessMimeFromExtension(source.absolutePath);
        case 'webview-blob':
        case 'recorder':
            return source.mimeType || guessMimeFromExtension(source.displayName);
    }
}

function sourceExtension(source: AudioSource): string {
    switch (source.kind) {
        case 'vault':
            return source.file.extension;
        case 'desktop-path': {
            const i = source.absolutePath.lastIndexOf('.');
            return i < 0 ? '' : source.absolutePath.slice(i + 1);
        }
        case 'webview-blob':
        case 'recorder': {
            const i = source.displayName.lastIndexOf('.');
            return i < 0 ? '' : source.displayName.slice(i + 1);
        }
    }
}

function getOriginalName(source: Exclude<AudioSource, { kind: 'vault' }>): string {
    if (source.kind === 'desktop-path') {
        const parts = source.absolutePath.split(/[\\/]/);
        return parts[parts.length - 1] || source.displayName || 'audio';
    }
    return source.displayName || 'audio';
}

// ============================================================================
// Per-kind reads
// ============================================================================

async function readSourceBytes(
    source: Exclude<AudioSource, { kind: 'vault' }>,
    signal?: AbortSignal
): Promise<Result<ArrayBuffer>> {
    if (signal?.aborted) return { ok: false, error: 'aborted' };

    if (source.kind === 'desktop-path') {
        const fs = getFs();
        if (!fs) return { ok: false, error: 'desktop-fs-unavailable' };
        try {
            const buf = await fs.promises.readFile(source.absolutePath);
            // Buffer is a Uint8Array subclass — slice into a clean ArrayBuffer.
            return {
                ok: true,
                value: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            };
        } catch (e) {
            logger.warn('AudioImport', `readFile(${source.absolutePath}) failed: ${String(e)}`);
            return { ok: false, error: 'read-failed' };
        }
    }

    // webview-blob / recorder
    try {
        const buf = await source.blob.arrayBuffer();
        return { ok: true, value: buf };
    } catch (e) {
        logger.warn('AudioImport', `blob.arrayBuffer() failed: ${String(e)}`);
        return { ok: false, error: 'read-failed' };
    }
}
