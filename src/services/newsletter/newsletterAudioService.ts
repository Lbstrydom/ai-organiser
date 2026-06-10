/**
 * Newsletter Audio Podcast Service
 *
 * Converts a Daily Brief text into an MP3 audio file using the shared TTS
 * engine layer. Uses hash-in-filename for idempotency (same content → same
 * filename, avoiding Windows file-locking issues with vault.modify on open
 * files).
 *
 * Phase 6 migration (April 2026): synthesis now goes through the shared
 * `GeminiTtsEngine` from `src/services/tts/`. Newsletter inherits:
 *   - Strict mime check (audio/L16 or audio/pcm only)
 *   - Retry-with-backoff on 429/5xx (was missing before — single transient
 *     failure mid-brief used to abort and waste paid chunks)
 *   - AbortSignal support — newsletter audio is now cancellable
 *   - Single source of truth for the Gemini TTS contract
 *
 * Removed in this migration: inline `callGeminiTts` (~55 lines), hardcoded
 * `GEMINI_TTS_ENDPOINT` constant, manual base64 + PCM decode (the engine
 * does this internally and returns `Int16Array` samples).
 */

import { App, normalizePath, TFile } from 'obsidian';
import { ensureFolderExists } from '../../utils/minutesUtils';
import {
    splitForTts,
    TTS_CHUNK_CHAR_TARGET,
    TTS_CHUNK_CHAR_MAX,
} from '../tts/ttsChunker';
import { downsamplePcm16, dynamicNormalize } from '../tts/pcmUtils';
import { Mp3Writer } from '../tts/mp3Writer';
import { sha256Hex } from '../tts/fingerprint';
import { GeminiTtsEngine, type TtsEngine } from '../tts/ttsEngine';
import { NARRATION_PROVIDERS } from '../tts/ttsProviderRegistry';
import { retryWithBackoff, DEFAULT_TTS_RETRY } from '../tts/ttsRetry';
import { logger } from '../../utils/logger';

const GEMINI_SOURCE_RATE = 24000;
const MP3_SAMPLE_RATE = 16000;
const MP3_CHANNELS = 1;
const MP3_BITRATE_KBPS = 48;

export interface AudioPodcastOptions {
    apiKey: string;
    voice: string;
    outputFolder: string;
    dateStr: string;
    /** Pre-built engine (e.g. Azure Speech). When omitted, a Gemini engine is
     *  built from `apiKey` (back-compat). Lets the caller pick the TTS provider. */
    engine?: TtsEngine;
    /** Model id to salt the idempotency fingerprint (defaults to the Gemini model). */
    modelId?: string;
    /**
     * Optional abort signal. When fired, the chunk-synthesis loop stops at
     * the next iteration (already-completed chunks are discarded; no MP3 is
     * written). Newsletter callers don't currently pass one, but the
     * parameter exists so future cancellable-fetch flows can plug in.
     */
    signal?: AbortSignal;
}

export interface AudioPodcastResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

/**
 * Generate (or skip if already current) an audio MP3 podcast from brief text.
 * Returns the vault path of the created file, or an error message.
 */
export async function generateAudioPodcast(
    app: App,
    script: string,
    opts: AudioPodcastOptions,
): Promise<AudioPodcastResult> {
    const { apiKey, voice, outputFolder, dateStr, signal } = opts;
    const { vault } = app;
    const provider = NARRATION_PROVIDERS.gemini;
    // Auto-latest TTS model (live catalog → known previews → pinned default), used for
    // BOTH the fingerprint and the engine so a model rotation regenerates the audio.
    const effectiveModel = opts.modelId ?? provider.getEffectiveModelId?.() ?? provider.modelId;
    const fpModel = effectiveModel;

    let fingerprint: string;
    try {
        // Salt with the engine's model id — when the model changes (or the
        // provider switches gemini↔azure) all existing audio is regenerated.
        fingerprint = await sha256Hex([script, voice, fpModel]);
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const shortFp = fingerprint.slice(0, 8);
    const fileName = `brief-${dateStr}-${shortFp}.mp3`;
    const filePath = normalizePath(`${outputFolder}/${fileName}`);

    // Idempotency: if this exact file already exists, nothing to do
    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
        return { success: true, filePath };
    }

    // Build the synthesis engine — shared with audio narration. Each chunk
    // call is wrapped in retryWithBackoff for transient-failure resilience.
    // Caller may supply an engine (e.g. Azure Speech); else build Gemini from apiKey.
    const engine = opts.engine ?? new GeminiTtsEngine(apiKey, effectiveModel);
    const chunks = splitScriptForTts(script);
    const writer = new Mp3Writer({
        sampleRate: MP3_SAMPLE_RATE,
        channels: MP3_CHANNELS,
        bitrateKbps: MP3_BITRATE_KBPS,
    });

    try {
        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const samples = await retryWithBackoff(
                () => engine.synthesizeChunk(chunks[i], voice, signal),
                DEFAULT_TTS_RETRY,
                signal,
                (attempt, delayMs, err) => logger.warn(
                    'Newsletter',
                    `TTS chunk ${i + 1}/${chunks.length} attempt ${attempt} failed (${describeError(err)}); retrying in ${delayMs}ms`,
                ),
            );
            const downsampled = downsamplePcm16(samples, GEMINI_SOURCE_RATE, MP3_SAMPLE_RATE);
            // Compensate Gemini's intra-chunk volume fade and inter-chunk level
            // drift before encoding (~30 ms / 90 s chunk on typical CPU).
            const normalized = dynamicNormalize(downsampled, MP3_SAMPLE_RATE);
            writer.push(normalized);
        }
    } catch (err) {
        return { success: false, error: describeError(err) };
    }

    // Finalize encode — guarded so writer.finish() throws surface as
    // { success: false } rather than escaping the Result contract.
    let mp3Bytes: Uint8Array;
    try {
        mp3Bytes = writer.finish();
    } catch (err) {
        return { success: false, error: `MP3 encode failed: ${describeError(err)}` };
    }

    // Write to vault
    try {
        await ensureFolderExists(app.vault, outputFolder);
        await vault.createBinary(
            filePath,
            mp3Bytes.buffer.slice(mp3Bytes.byteOffset, mp3Bytes.byteOffset + mp3Bytes.byteLength) as ArrayBuffer,
        );
        await pruneStaleAudioFiles(app, outputFolder, dateStr, shortFp);
    } catch (err) {
        return { success: false, error: describeError(err) };
    }

    return { success: true, filePath };
}

// ── TTS chunking ─────────────────────────────────────────────────────────────

/**
 * Backwards-compatible alias for the shared chunker. Keeps the existing
 * export name (used in `tests/newsletterAudioChunking.test.ts`) while the
 * actual implementation lives in `tts/ttsChunker`.
 */
export function splitScriptForTts(script: string): string[] {
    return splitForTts(script, TTS_CHUNK_CHAR_TARGET, TTS_CHUNK_CHAR_MAX);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Remove WAV files for the same date that have a different fingerprint suffix.
 * Handles the case where the brief content changed and a new file was written.
 */
async function pruneStaleAudioFiles(
    app: App,
    outputFolder: string,
    dateStr: string,
    currentShortFp: string,
): Promise<void> {
    const folderFile = app.vault.getAbstractFileByPath(normalizePath(outputFolder));
    if (!folderFile || !('children' in folderFile)) return;
    // Match both legacy `.wav` outputs and the current `.mp3` format so
    // upgrading users don't leak old WAV files alongside the new MP3.
    const pattern = new RegExp(String.raw`^brief-${dateStr}-([a-f0-9]{8})\.(wav|mp3)$`);
    for (const child of (folderFile as { children: unknown[] }).children) {
        if (!(child instanceof TFile)) continue;
        const m = pattern.exec(child.name);
        if (m) {
            const isStaleFingerprint = m[1] !== currentShortFp;
            const isLegacyWav = m[2] === 'wav';
            if (isStaleFingerprint || isLegacyWav) {
                try {
                    await app.fileManager.trashFile(child);
                } catch {
                    // best-effort — stale file cleanup is non-critical
                }
            }
        }
    }
}
