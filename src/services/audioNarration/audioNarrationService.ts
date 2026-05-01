/**
 * Audio narration service — the two-stage canonical pipeline.
 *
 *   prepareNarration(plugin, file)         — pure: read + transform + estimate + fingerprint
 *   executeNarration(plugin, prepared, …)  — side-effecting: synth + write + embed
 *
 * Commands consume the prepared struct read-only — no duplicated read/transform/estimate
 * logic anywhere else. This is the H1 fix from R1 audit.
 */

import { type App, normalizePath, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { ensureFolderExists } from '../../utils/minutesUtils';
import { ok, err, type Result } from '../../core/result';
import { getAudioNarrationFullPath } from '../../core/settings';
import { ensurePrivacyConsent } from '../privacyNotice';

import { Mp3Writer } from '../tts/mp3Writer';
import { downsamplePcm16 } from '../tts/pcmUtils';
import { splitForTts } from '../tts/ttsChunker';
import { sha256Hex, CryptoUnavailableError } from '../tts/fingerprint';
import { retryWithBackoff } from '../tts/ttsRetry';
import { getProvider, type NarrationProviderId } from '../tts/ttsProviderRegistry';

import { transformToSpokenProse } from './markdownToProseTransformer';
import { estimateNarrationCost } from './narrationCostEstimator';
import { syncEmbed } from './narrationEmbedManager';
import type { ProgressReporter } from '../progress/progressReporter';
import {
    encodeError,
    errFrom,
    makeError,
    type NarrateOutcome,
    type NarrationPhase,
    type PreparedNarration,
} from './narrationTypes';

const SOURCE_RATE = 24000;
const TARGET_RATE = 16000;
const MP3_BITRATE_KBPS = 48;
const FINGERPRINT_PREFIX_LEN = 8;

/**
 * Windows reserved device basenames — even with an extension, files named
 * after these break Win32 path APIs. Audit R2-H4: must be rewritten before
 * touching the filesystem.
 */
const WINDOWS_RESERVED_BASENAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Sanitise a basename for use in a vault output path that will also appear
 * inside an Obsidian wikilink (`![[...]]`). Strips:
 *   - filesystem-illegal characters: `/ \ : * ? " < > |`
 *   - wikilink-reserved characters: `[ ] # ^` (audit R2-M6)
 *   - tab/newline whitespace
 *
 * Then maps Windows reserved device names to a safe prefix (audit R2-H4),
 * collapses dot-only / empty results to a default fallback, and caps length
 * at 80 chars (Windows MAX_PATH safety on deeply nested vaults).
 *
 * Preserves Unicode letters/digits.
 */
function sanitiseFilename(name: string): string {
    let cleaned = name
        .replace(/[/\\:*?"<>|[\]#^]/g, '')
        .replace(/[\t\r\n]/g, ' ')
        .trim();
    cleaned = cleaned.replace(/\s+/g, ' ').replace(/^\.+/, '').replace(/\.+$/, '').trim();
    if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).trim();
    if (!cleaned) return 'narration';

    // Windows reserved device names: rewrite "CON" → "narration-CON" rather than
    // refusing — preserves user-recognisable hint while staying valid.
    const upperBase = cleaned.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_BASENAMES.has(upperBase)) {
        cleaned = `narration-${cleaned}`;
    }
    return cleaned;
}

export function buildOutputPath(
    plugin: AIOrganiserPlugin,
    file: TFile,
    fingerprint: string,
): string {
    const folder = getAudioNarrationFullPath(plugin.settings);
    const base = sanitiseFilename(file.basename);
    const fp8 = fingerprint.slice(0, FINGERPRINT_PREFIX_LEN);
    return normalizePath(`${folder}/${base}.${fp8}.mp3`);
}

// ── Stage 1: prepareNarration ───────────────────────────────────────────────

export async function prepareNarration(
    plugin: AIOrganiserPlugin,
    file: TFile,
): Promise<Result<PreparedNarration>> {
    // Read note
    let raw: string;
    try {
        raw = await plugin.app.vault.read(file);
    } catch (e) {
        return errFrom<PreparedNarration>(makeError('TRANSFORM_FAILED', `Could not read note: ${describeError(e)}`, e));
    }

    // Transform
    let spokenText: string;
    let stats;
    let warnings: string[];
    try {
        const result = transformToSpokenProse(raw);
        spokenText = result.spokenText;
        stats = result.stats;
        warnings = result.warnings;
    } catch (e) {
        return errFrom<PreparedNarration>(makeError('TRANSFORM_FAILED', `Could not parse note: ${describeError(e)}`, e));
    }

    if (warnings.length > 0) {
        logger.debug('AudioNarration', `Transformer warnings: ${warnings.join(', ')}`);
    }

    if (!spokenText.trim()) {
        return errFrom<PreparedNarration>(makeError('EMPTY_CONTENT', 'Note has no readable content after stripping frontmatter and code blocks.'));
    }

    // Resolve provider
    const providerId: NarrationProviderId = plugin.settings.audioNarrationProvider || 'gemini';
    let provider;
    try {
        provider = getProvider(providerId);
    } catch (e) {
        return errFrom<PreparedNarration>(makeError('ESTIMATE_FAILED', `Unknown provider: ${providerId}`, e));
    }

    // Resolve voice (fallback to provider default)
    const voice = plugin.settings.audioNarrationVoice || provider.defaultVoice;

    // Verify API key resolvable (do not actually call the API yet)
    const engine = await provider.factory(plugin);
    if (!engine) {
        return errFrom<PreparedNarration>(makeError('NO_API_KEY', `No API key configured for ${provider.displayName}.`));
    }

    // Estimate cost
    let cost;
    try {
        cost = estimateNarrationCost(spokenText, providerId, voice);
    } catch (e) {
        return errFrom<PreparedNarration>(makeError('ESTIMATE_FAILED', `Cost estimation failed: ${describeError(e)}`, e));
    }

    // Fingerprint (depends on content + voice + model — voice change → new file)
    let fingerprint: string;
    try {
        fingerprint = await sha256Hex([file.path, spokenText, voice, provider.modelId]);
    } catch (e) {
        if (e instanceof CryptoUnavailableError) {
            return errFrom<PreparedNarration>(makeError('UNSUPPORTED_PLATFORM', e.message, e));
        }
        return errFrom<PreparedNarration>(makeError('TRANSFORM_FAILED', `Hash failed: ${describeError(e)}`, e));
    }

    const outputPath = buildOutputPath(plugin, file, fingerprint);
    const existingAbs = plugin.app.vault.getAbstractFileByPath(outputPath);
    const existingFile = (existingAbs instanceof TFile && existingAbs.extension === 'mp3')
        ? existingAbs
        : null;

    const embedInNote = plugin.settings.audioNarrationEmbedInNote ?? true;

    return ok<PreparedNarration>({
        file,
        spokenText,
        stats,
        cost,
        fingerprint,
        outputPath,
        existingFile,
        provider,
        voice,
        embedInNote,
    });
}

// ── Stage 2: executeNarration ───────────────────────────────────────────────

export interface ExecuteOptions {
    signal?: AbortSignal;
    reporter?: ProgressReporter<NarrationPhase>;
}

export async function executeNarration(
    plugin: AIOrganiserPlugin,
    prepared: PreparedNarration,
    opts: ExecuteOptions = {},
): Promise<Result<NarrateOutcome>> {
    const { signal, reporter } = opts;

    // Build engine (factory already validated key in prepareNarration, but key
    // could have been invalidated since — handle nullish defensively)
    const engine = await prepared.provider.factory(plugin);
    if (!engine) {
        return errFrom<NarrateOutcome>(makeError('NO_API_KEY', `Lost API key for ${prepared.provider.displayName}.`));
    }

    // ── Phase: narrating (cancellable) ──────────────────────────────────────
    const writer = new Mp3Writer({ sampleRate: TARGET_RATE, channels: 1, bitrateKbps: MP3_BITRATE_KBPS });
    const chunks = splitForTts(prepared.spokenText);
    const total = chunks.length;

    try {
        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            reporter?.setPhase({ key: 'narrating', params: { current: i + 1, total } });

            const samples = await retryWithBackoff(
                (_attempt) => engine.synthesizeChunk(chunks[i], prepared.voice, signal),
                undefined,
                signal,
                (attempt, delayMs, err) => logger.warn(
                    'AudioNarration',
                    `chunk ${i + 1}/${total} attempt ${attempt} failed (${describeError(err)}); retrying in ${delayMs}ms`,
                ),
            );

            const downsampled = downsamplePcm16(samples, SOURCE_RATE, TARGET_RATE);
            writer.push(downsampled);
        }
    } catch (e) {
        if (isAbort(e)) {
            return err<NarrateOutcome>(encodeError(makeError('ABORTED', 'cancelled')));
        }
        return errFrom<NarrateOutcome>(makeError('TTS_FAILED', `TTS failed: ${describeError(e)}`, e));
    }

    // ── Past abort boundary — encoding/writing are NOT cancellable ──────────
    reporter?.setCancellable?.(false);
    reporter?.setPhase({ key: 'encoding' });

    let mp3Bytes: Uint8Array;
    try {
        mp3Bytes = writer.finish();
    } catch (e) {
        return errFrom<NarrateOutcome>(makeError('ENCODE_FAILED', `MP3 encode failed: ${describeError(e)}`, e));
    }

    reporter?.setPhase({ key: 'writing' });

    // Folder lifecycle (R2-H1)
    try {
        const folder = parentFolder(prepared.outputPath);
        await ensureFolderExists(plugin.app.vault, folder);
    } catch (e) {
        return errFrom<NarrateOutcome>(makeError('WRITE_FAILED', `Could not create output folder: ${describeError(e)}`, e));
    }

    // Vault write — revalidate idempotency at write boundary (audit R2-M5).
    // Between prepareNarration and now, another window/sync/manual copy could
    // have created the same fingerprint-keyed file. If so, treat this run as
    // idempotent: skip the write (don't overwrite) but still sync the embed.
    let skippedExisting = false;
    const existingAtWrite = plugin.app.vault.getAbstractFileByPath(prepared.outputPath);
    if (existingAtWrite instanceof TFile && existingAtWrite.extension === 'mp3') {
        skippedExisting = true;
        logger.debug('AudioNarration', `Skipped write — fingerprint match already at ${prepared.outputPath}`);
    } else {
        try {
            await plugin.app.vault.createBinary(
                prepared.outputPath,
                mp3Bytes.buffer.slice(mp3Bytes.byteOffset, mp3Bytes.byteOffset + mp3Bytes.byteLength) as ArrayBuffer,
            );
        } catch (e) {
            return errFrom<NarrateOutcome>(makeError('WRITE_FAILED', `Could not save MP3: ${describeError(e)}`, e));
        }
    }

    // Embed sync (non-fatal)
    let embedUpdated = false;
    const embedResult = await syncEmbed(plugin.app, prepared.file, prepared.outputPath, prepared.embedInNote);
    if (embedResult.ok) {
        embedUpdated = true;
    } else {
        logger.warn('AudioNarration', `Embed sync failed: ${embedResult.error}`);
    }

    return ok<NarrateOutcome>({
        filePath: prepared.outputPath,
        bytes: mp3Bytes.byteLength,
        durationSec: prepared.cost.estDurationSec,
        skippedExisting,
        embedUpdated,
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parentFolder(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx > 0 ? path.slice(0, idx) : '';
}

function describeError(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

function isAbort(e: unknown): boolean {
    if (e instanceof DOMException && e.name === 'AbortError') return true;
    if (e instanceof Error && e.name === 'AbortError') return true;
    return false;
}

// Re-export for convenience
export { ensurePrivacyConsent };
export type { App };
