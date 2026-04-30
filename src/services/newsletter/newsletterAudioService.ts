/**
 * Newsletter Audio Podcast Service
 *
 * Converts a Daily Brief text into an MP3 audio file using the shared
 * TtsEngine abstraction (GeminiTtsEngine). Retry-with-backoff and
 * AbortSignal support are inherited for free from ttsRetry.ts.
 *
 * Uses hash-in-filename for idempotency (same content → same filename,
 * avoiding Windows file-locking issues with vault.modify on open files).
 */

import { App, normalizePath, TFile } from 'obsidian';
import { ensureFolderExists } from '../../utils/minutesUtils';
import lamejs from '@breezystack/lamejs';
import { NARRATION_PROVIDERS } from '../tts/ttsProviderRegistry';
import { retryWithBackoff } from '../tts/ttsRetry';

// Gemini returns LINEAR16 PCM at 24 kHz. For a speech-only podcast we:
//   1. Downsample to 16 kHz (speech energy is <4 kHz — no audible loss)
//   2. Encode as MP3 at 48 kbps mono
// Net result: ~5-min brief goes from ~14 MB WAV to ~2 MB MP3 — fits under
// any reasonable sync / storage cap. lamejs is pure-JS (no native deps).
const GEMINI_SOURCE_RATE = 24000;
const MP3_SAMPLE_RATE = 16000;
const MP3_CHANNELS = 1;
const MP3_BITRATE_KBPS = 48;
/** Target chunk size in characters for TTS. Gemini (and most neural TTS
 *  models) lose energy / expressiveness the further they generate because
 *  attention weights decay over long sequences — users report audio
 *  getting "softer and softer toward the end" on 5-minute briefs. Splitting
 *  the script into ~90-second chunks and concatenating the resulting PCM
 *  keeps each generation short enough to stay in the model's steady-state
 *  range. ~150 words per minute × 1.5 min × ~5 chars/word ≈ 1100 chars. */
const TTS_CHUNK_CHAR_TARGET = 1100;
/** Hard max per chunk — even a very long single sentence shouldn't exceed
 *  this, to keep us well inside any API limit and the model's sweet spot. */
const TTS_CHUNK_CHAR_MAX = 1800;
const MAX_RETRY_ATTEMPTS = 3;

export interface AudioPodcastOptions {
    apiKey: string;
    voice: string;
    outputFolder: string;
    dateStr: string;
}

export interface AudioPodcastResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

/**
 * Generate (or skip if already current) an MP3 audio podcast from brief text.
 * Returns the vault path of the created file, or an error message.
 *
 * @param signal Optional AbortSignal — passed through to each TTS chunk call
 *               so the user can cancel a long generation mid-flight.
 *               The newsletter service caller does not need to pass one yet;
 *               the parameter is optional to preserve backward compatibility.
 */
export async function generateAudioPodcast(
    app: App,
    script: string,
    opts: AudioPodcastOptions,
    signal?: AbortSignal,
): Promise<AudioPodcastResult> {
    const { apiKey, voice, outputFolder, dateStr } = opts;
    const { vault } = app;

    const engine = NARRATION_PROVIDERS.gemini.factory(apiKey, voice);
    const fingerprint = await computeFingerprint(script, voice, engine.modelId);
    const shortFp = fingerprint.slice(0, 8);
    const fileName = `brief-${dateStr}-${shortFp}.mp3`;
    const filePath = normalizePath(`${outputFolder}/${fileName}`);

    // Idempotency: if this exact file already exists, nothing to do
    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
        return { success: true, filePath };
    }

    // Split the script into TTS-sized chunks so each Gemini call stays in
    // the model's steady-state energy range. Fallback to single-call if the
    // script is already short enough.
    const chunks = splitScriptForTts(script);

    // Synthesise each chunk with retry-with-backoff. LINEAR16 PCM is
    // naturally concatenatable (no headers, no framing) so splice-and-stitch
    // produces a continuous waveform.
    const pcmSegments: Uint8Array[] = [];
    try {
        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                return { success: false, error: 'Aborted' };
            }
            const result = await retryWithBackoff(
                () => engine.synthesizeChunk(chunks[i], signal),
                MAX_RETRY_ATTEMPTS,
                signal,
            );
            if (result === null) {
                return { success: false, error: `Gemini TTS returned no valid audio for chunk ${i + 1}/${chunks.length}` };
            }
            pcmSegments.push(base64ToUint8Array(result));
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const rawPcm = concatenateBuffers(pcmSegments);
    const pcmBytes = downsamplePcm16(rawPcm, GEMINI_SOURCE_RATE, MP3_SAMPLE_RATE);
    const mp3Bytes = encodePcmToMp3(pcmBytes, MP3_SAMPLE_RATE, MP3_CHANNELS, MP3_BITRATE_KBPS);

    // Write to vault
    try {
        await ensureFolderExists(app.vault, outputFolder);
        await vault.createBinary(filePath, mp3Bytes);

        // Prune any stale brief audio files for the same date
        await pruneStaleAudioFiles(app, outputFolder, dateStr, shortFp);
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { success: true, filePath };
}

// ── MP3 encoding (lamejs, pure-JS, CBR) ─────────────────────────────────────

/**
 * Encode mono LINEAR16 PCM to MP3 at a fixed bitrate. Uses lamejs in
 * 1152-sample frames (the MPEG-1 Layer-III frame size). Returns an
 * ArrayBuffer containing the complete MP3 stream.
 */
function encodePcmToMp3(
    pcm: Uint8Array,
    sampleRate: number,
    channels: number,
    bitrateKbps: number,
): ArrayBuffer {
    const encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitrateKbps);
    const frameSize = 1152;
    const sampleCount = Math.floor(pcm.byteLength / 2);
    // View PCM bytes as Int16 samples (little-endian matches host order on
    // all consumer targets; lamejs assumes native).
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
    // lamejs returns Uint8Array frames (per @breezystack/lamejs/type.d.ts).
    const chunks: Uint8Array[] = [];
    const pushChunk = (c: Uint8Array): void => {
        if (c.length > 0) chunks.push(c);
    };
    for (let i = 0; i < sampleCount; i += frameSize) {
        const frame = samples.subarray(i, Math.min(i + frameSize, sampleCount));
        pushChunk(encoder.encodeBuffer(frame));
    }
    pushChunk(encoder.flush());

    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/**
 * Downsample LINEAR16 PCM (mono) from one rate to another using a box-filter
 * decimation — for each output sample, average the input samples in its
 * window. Good enough for speech, acts as a crude anti-alias filter, no
 * external dependencies. If `sourceRate === targetRate`, returns input
 * unchanged.
 */
function downsamplePcm16(pcm: Uint8Array, sourceRate: number, targetRate: number): Uint8Array {
    if (sourceRate === targetRate) return pcm;
    const ratio = sourceRate / targetRate;
    const inputView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const inputSampleCount = Math.floor(pcm.byteLength / 2);
    const outputSampleCount = Math.floor(inputSampleCount / ratio);
    const output = new Uint8Array(outputSampleCount * 2);
    const outputView = new DataView(output.buffer);

    for (let i = 0; i < outputSampleCount; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), inputSampleCount);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += inputView.getInt16(j * 2, true);
            count++;
        }
        const avg = count > 0 ? Math.round(sum / count) : 0;
        // Clamp to int16 range just in case.
        const clamped = Math.max(-32768, Math.min(32767, avg));
        outputView.setInt16(i * 2, clamped, true);
    }
    return output;
}

// ── TTS chunking ─────────────────────────────────────────────────────────────

/**
 * Split a podcast script into TTS-sized chunks so each Gemini call stays in
 * the model's steady-state energy range. Splits on paragraph boundaries
 * first (natural breath points), falling back to sentence boundaries for
 * long paragraphs. Short scripts pass through unchunked.
 *
 * Exported for tests.
 */
export function splitScriptForTts(script: string): string[] {
    const trimmed = script.trim();
    if (trimmed.length <= TTS_CHUNK_CHAR_TARGET) return [trimmed];

    // Split on paragraph breaks, then pack paragraphs into chunks until
    // adding the next one would exceed the target.
    const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';
    for (const para of paragraphs) {
        // If a single paragraph is too big on its own, sentence-split it.
        if (para.length > TTS_CHUNK_CHAR_MAX) {
            if (current) { chunks.push(current); current = ''; }
            chunks.push(...splitParagraphIntoSentences(para));
            continue;
        }
        const candidate = current ? `${current}\n\n${para}` : para;
        if (candidate.length > TTS_CHUNK_CHAR_TARGET && current) {
            chunks.push(current);
            current = para;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [trimmed];
}

/** Sentence-level fallback for a paragraph that exceeds TTS_CHUNK_CHAR_MAX. */
function splitParagraphIntoSentences(paragraph: string): string[] {
    // Naive sentence split — good enough for LLM-authored prose which uses
    // normal punctuation. Keeps the terminator on the preceding sentence.
    const sentences = paragraph.match(/(?:[^.!?]+[.!?]+(?:\s+|$))|(?:[^.!?]+$)/g) ?? [paragraph];
    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        const candidate = current ? `${current} ${s}` : s;
        if (candidate.length > TTS_CHUNK_CHAR_TARGET && current) {
            chunks.push(current);
            current = s;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function concatenateBuffers(buffers: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const b of buffers) total += b.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) {
        out.set(b, offset);
        offset += b.byteLength;
    }
    return out;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.codePointAt(i) ?? 0;
    }
    return bytes;
}

/**
 * Compute a SHA-256 fingerprint of (script + voice + modelId) using Web Crypto API.
 * Returns a lowercase hex string. Async because SubtleCrypto.digest is async.
 *
 * `modelId` replaces the old inline GEMINI_TTS_ENDPOINT constant so the
 * fingerprint contract is now: hash(script \x00 voice \x00 engine.modelId).
 * Because GeminiTtsEngine.modelId equals the former endpoint string, all
 * files generated before this refactor are still recognised as current.
 */
async function computeFingerprint(script: string, voice: string, modelId: string): Promise<string> {
    const raw = script + '\x00' + voice + '\x00' + modelId;
    const encoded = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Remove WAV files for the same date that have a different fingerprint suffix.
 * Handles the case where the brief content changed and a new file was written.
 */
async function pruneStaleAudioFiles(
    app: App,
    outputFolder: string,
    dateStr: string,
    currentShortFp: string
): Promise<void> {
    const folderFile = app.vault.getAbstractFileByPath(normalizePath(outputFolder));
    if (!folderFile || !('children' in folderFile)) return;
    // Match both the legacy `.wav` outputs and the current `.mp3` format so
    // upgrading users don't leak old WAV files alongside the new MP3.
    const pattern = new RegExp(String.raw`^brief-${dateStr}-([a-f0-9]{8})\.(wav|mp3)$`);
    for (const child of (folderFile as { children: unknown[] }).children) {
        if (!(child instanceof TFile)) continue;
        const m = pattern.exec(child.name);
        if (m) {
            // Delete if it's an older fingerprint, or a .wav from before
            // the MP3 switchover (same fingerprint but wrong extension
            // still doesn't happen because fingerprint also encodes format).
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
