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
import { downsamplePcm16, dynamicNormalize } from '../tts/pcmUtils';
import { splitForTts } from '../tts/ttsChunker';
import { sha256Hex, CryptoUnavailableError } from '../tts/fingerprint';
import { retryWithBackoff } from '../tts/ttsRetry';
import { getProvider, NARRATION_PROVIDERS, type NarrationProviderId } from '../tts/ttsProviderRegistry';

import { transformToSpokenProse } from './markdownToProseTransformer';
import { estimateNarrationCost, estimateLlmEnhancementCostUsd } from './narrationCostEstimator';
import { syncEmbed } from './narrationEmbedManager';
import { enhanceMarkdown } from './llmMarkdownEnhancer';
import { LLM_ENHANCEMENT_PROVIDERS } from './llmEnhancerProvider';
import { LLM_ENHANCEMENT_PROMPT_VERSION } from './llmEnhancerPrompts';
import { hasLlmEnhancementKey, resolveLlmEnhancementApiKey } from '../apiKeyHelpers';
import type { ProgressReporter } from '../progress/progressReporter';
import {
    encodeError,
    errFrom,
    makeError,
    type LlmEnhancementIntent,
    type MarkdownToProseOptions,
    type NarrateOutcome,
    type NarrationPhase,
    type NarrationWarning,
    type PreparedNarration,
} from './narrationTypes';
import { isAzureMode } from '../azure/endpointResolver';
import { resolveAzureCapability } from '../azure/resolveAzureCapability';
import { assertAllowed } from '../azure/audioProviderPolicy';

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

/** Spoken-content rendering modes from settings (code/table/image handling).
 *  Defaults match DEFAULT_PROSE_OPTIONS, so a user who never changes them gets
 *  byte-identical spokenText (and therefore an unchanged narration fingerprint). */
function proseOptionsFromSettings(plugin: AIOrganiserPlugin): Partial<MarkdownToProseOptions> {
    return {
        codeBlockMode: plugin.settings.audioNarrationCodeBlockMode,
        tableMode: plugin.settings.audioNarrationTableMode,
        imageMode: plugin.settings.audioNarrationImageMode,
    };
}

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
        const result = transformToSpokenProse(raw, proseOptionsFromSettings(plugin));
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

    // Resolve provider. In Azure mode the tts capability decides: azure → the
    // Azure Speech engine; byo → the configured gemini provider; off/unavailable
    // → a clear NO_API_KEY (the command maps it to an Azure-aware message).
    // Registry-membership narrowing: settings may carry ids whose engine ships in a
    // later phase (e.g. `openai-gpt-audio`, plan Phase 4) — an id without a registry
    // entry falls back to gemini; once the entry exists it flows through unchanged.
    const configuredNarration: string = plugin.settings.audioNarrationProvider || 'gemini';
    let providerId: NarrationProviderId = configuredNarration in NARRATION_PROVIDERS
        ? (configuredNarration as NarrationProviderId)
        : 'gemini';
    if (isAzureMode(plugin.settings)) {
        const ttsRes = await resolveAzureCapability(plugin, 'tts');
        if (ttsRes.kind === 'azure' && ttsRes.surface === 'azure-speech') {
            // The Cognitive Speech engine ships in plan Phase 3. Until it exists,
            // FAIL CLOSED rather than silently downgrade an azure-speech
            // resolution (possibly strict/compliance mode, D3) to the
            // Global-Standard /audio/speech engine.
            return errFrom<PreparedNarration>(makeError('NO_API_KEY', 'Azure Speech narration engine is not yet available.'));
        }
        if (ttsRes.kind === 'azure') providerId = 'azure-openai';
        else if (ttsRes.kind === 'unavailable') {
            return errFrom<PreparedNarration>(makeError('NO_API_KEY', 'Audio narration is not configured for Azure.'));
        }
        // ttsRes.kind === 'byo' → keep the gemini providerId (existing path).
    }

    // Call-time compliance guard (plan D8): every audio entry consults the
    // policy with the RESOLVED provider, so a stale/disallowed persisted
    // provider fails closed here regardless of how it was reached.
    const policyCheck = assertAllowed(plugin, { op: 'tts', providerId });
    if (!policyCheck.ok) {
        return errFrom<PreparedNarration>(makeError('NO_API_KEY', `Narration provider not permitted: ${policyCheck.error}`));
    }

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

    // Estimate cost (TTS only at this point)
    let cost;
    try {
        cost = estimateNarrationCost(spokenText, providerId, voice);
    } catch (e) {
        return errFrom<PreparedNarration>(makeError('ESTIMATE_FAILED', `Cost estimation failed: ${describeError(e)}`, e));
    }

    // LLM enhancement intent + cost estimate (plan §1.5).
    // No LLM call here — just identity + char-based cost math. Key
    // availability checked via hasLlmEnhancementKey (boolean, doesn't
    // expose the key value). If mode='on' but no key resolves, llmIntent
    // stays null → the cost modal won't show an AI line, and execute
    // will fall back to literal mode with a warning.
    let llmIntent: LlmEnhancementIntent | null = null;
    if (plugin.settings.audioNarrationLlmEnhancement === 'on') {
        const llmProviderId = plugin.settings.audioNarrationLlmProvider;
        const llmProviderConfig = LLM_ENHANCEMENT_PROVIDERS[llmProviderId];
        const keyAvailable = await hasLlmEnhancementKey(plugin, llmProviderId);
        if (keyAvailable) {
            cost.llmEnhancementUsd = estimateLlmEnhancementCostUsd(raw.length, llmProviderConfig);
            llmIntent = { providerId: llmProviderConfig.id, modelSentinel: llmProviderConfig.modelSentinel };
        }
    }

    // Fingerprint — branches on resolved llmIntent (Gemini G-M1):
    //   off-mode (or on-mode without key) → BYTE-IDENTICAL v1 tuple
    //   on-mode with key → distinct domain via 'llm-on' separator + mtime
    const fingerprintMtime = file.stat?.mtime ?? 0;
    // Use the EFFECTIVE (auto-resolved) model so a TTS model rotation invalidates the
    // cache — must match what the engine actually calls (ttsProviderRegistry factory).
    const fpModel = provider.getEffectiveModelId?.() ?? provider.modelId;
    let fingerprint: string;
    try {
        if (!llmIntent) {
            fingerprint = await sha256Hex([file.path, spokenText, voice, fpModel]);
        } else {
            fingerprint = await sha256Hex([
                file.path,
                String(fingerprintMtime),
                voice,
                fpModel,
                llmIntent.providerId,
                llmIntent.modelSentinel,
                String(LLM_ENHANCEMENT_PROMPT_VERSION),
                'llm-on',
            ]);
        }
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
        llmIntent,
        fingerprintMtime,
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
    const warnings: NarrationWarning[] = [];

    // TOCTOU mtime re-check (R3 H3) — if the note changed between prepare
    // and now (modal open, user edited the source), the prepared
    // fingerprint/outputPath/spokenText are stale. Fail safe and let the
    // user re-narrate against current content.
    if (prepared.file.stat?.mtime !== prepared.fingerprintMtime) {
        return errFrom<NarrateOutcome>(makeError('STALE_PREPARED',
            'Note changed between cost confirmation and narration; please run again.'));
    }

    // Build engine (factory already validated key in prepareNarration, but key
    // could have been invalidated since — handle nullish defensively)
    const engine = await prepared.provider.factory(plugin);
    if (!engine) {
        return errFrom<NarrateOutcome>(makeError('NO_API_KEY', `Lost API key for ${prepared.provider.displayName}.`));
    }

    // ── LLM enhancement (post-consent) ──────────────────────────────────────
    // The prepared.spokenText was derived from raw markdown for the cost
    // estimate. If LLM enhancement is intended AND the user's settings still
    // match the snapshotted intent, run the LLM and re-transform.
    let spokenText = prepared.spokenText;
    if (prepared.llmIntent) {
        // Surface the LLM phase BEFORE the call so the user sees
        // "Enhancing with AI…" instead of the misleading "Narrating chunk 0/N"
        // (the initial phase set by handleNarrateActiveNote). Live-spot-check
        // 2026-05-24 showed the status bar appeared frozen during this stage.
        reporter?.setPhase({ key: 'enhancing' });
        const intentStillValid =
            plugin.settings.audioNarrationLlmEnhancement === 'on'
            && plugin.settings.audioNarrationLlmProvider === prepared.llmIntent.providerId;
        if (!intentStillValid) {
            warnings.push({ code: 'llm-enhancement-disabled-no-key', detail: 'settings-changed-during-narration' });
        } else {
            const apiKey = await resolveLlmEnhancementApiKey(plugin, prepared.llmIntent.providerId);
            if (!apiKey) {
                warnings.push({ code: 'llm-enhancement-disabled-no-key' });
            } else {
                let rawForLlm: string;
                try {
                    rawForLlm = await plugin.app.vault.read(prepared.file);
                } catch (e) {
                    warnings.push({ code: 'llm-enhancement-failed', detail: describeError(e) });
                    rawForLlm = '';
                }
                if (rawForLlm) {
                    const provider = LLM_ENHANCEMENT_PROVIDERS[prepared.llmIntent.providerId];
                    const enhanced = await enhanceMarkdown(
                        plugin.app, rawForLlm, provider, apiKey,
                        {}, signal,
                    );
                    if (enhanced.ok) {
                        const enhancedSpokenText = transformToSpokenProse(enhanced.value.enhancedMarkdown, proseOptionsFromSettings(plugin)).spokenText;
                        // Hard cap (R3 H4 + Gemini G-H1) — compare to RAW
                        // markdown length, not stripped spokenText. Spike
                        // showed 84-114% ratio; 1.2× headroom + 4 KB floor.
                        const cap = Math.max(rawForLlm.length * 1.2, 4096);
                        if (enhancedSpokenText.length > cap) {
                            warnings.push({
                                code: 'llm-enhancement-failed',
                                detail: `output-too-large:${enhancedSpokenText.length}>${Math.round(cap)}`,
                            });
                            // Fall through with original spokenText
                        } else {
                            spokenText = enhancedSpokenText;
                            if (enhanced.value.failedChunkTitles.length > 0) {
                                warnings.push({
                                    code: 'llm-enhancement-partial',
                                    failedChunkTitles: enhanced.value.failedChunkTitles,
                                });
                            }
                        }
                    } else if (enhanced.error === 'aborted') {
                        return err<NarrateOutcome>(encodeError(makeError('ABORTED', 'cancelled')));
                    } else {
                        warnings.push({ code: 'llm-enhancement-failed', detail: enhanced.error });
                    }
                }
            }
        }
    }

    // ── Phase: narrating (cancellable) ──────────────────────────────────────
    const writer = new Mp3Writer({ sampleRate: TARGET_RATE, channels: 1, bitrateKbps: MP3_BITRATE_KBPS });
    const chunks = splitForTts(spokenText);
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
            // Compensate Gemini's intra-chunk volume fade and inter-chunk level
            // drift before encoding. ~30 ms / 90 s chunk on typical CPU.
            const normalized = dynamicNormalize(downsampled, TARGET_RATE);
            writer.push(normalized);
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
        warnings,
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
