/**
 * Newsletter Audio Podcast Service
 *
 * Converts a Daily Brief text into a WAV audio file using the Gemini TTS API.
 * Uses hash-in-filename for idempotency (same content → same filename, avoiding
 * Windows file-locking issues with vault.modify on open files).
 */

import { App, normalizePath, requestUrl, TFile } from 'obsidian';
import { ensureFolderExists } from '../../utils/minutesUtils';
import lamejs from '@breezystack/lamejs';

// Google's naming inverted between 2.x and 3.x — 2.5 used `-preview-tts`
// suffix, 3.1 uses `-tts-preview`. Confirmed against the official Gemini
// API speech-generation docs (2026-04-20). All TTS models are in Preview
// status — no GA variant yet. Response schema is unchanged between
// versions so no other code needs to adapt.
const GEMINI_TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent';
// Gemini returns LINEAR16 PCM at 24 kHz. For a speech-only podcast we:
//   1. Downsample to 16 kHz (speech energy is <4 kHz — no audible loss)
//   2. Encode as MP3 at 48 kbps mono
// Net result: ~5-min brief goes from ~14 MB WAV to ~2 MB MP3 — fits under
// any reasonable sync / storage cap. lamejs is pure-JS (no native deps).
const GEMINI_SOURCE_RATE = 24000;
const MP3_SAMPLE_RATE = 16000;
const MP3_CHANNELS = 1;
const MP3_BITRATE_KBPS = 48;

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
 * Generate (or skip if already current) an audio WAV podcast from brief text.
 * Returns the vault path of the created file, or an error message.
 */
export async function generateAudioPodcast(
    app: App,
    script: string,
    opts: AudioPodcastOptions
): Promise<AudioPodcastResult> {
    const { apiKey, voice, outputFolder, dateStr } = opts;
    const { vault } = app;

    const fingerprint = await computeFingerprint(script, voice);
    const shortFp = fingerprint.slice(0, 8);
    const fileName = `brief-${dateStr}-${shortFp}.mp3`;
    const filePath = normalizePath(`${outputFolder}/${fileName}`);

    // Idempotency: if this exact file already exists, nothing to do
    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
        return { success: true, filePath };
    }

    // Call Gemini TTS
    let pcmBase64: string;
    try {
        const result = await callGeminiTts(apiKey, voice, script);
        if (result === null) {
            return { success: false, error: 'Gemini TTS returned no valid audio payload' };
        }
        pcmBase64 = result;
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Decode base64 PCM → downsample to 16 kHz → encode as MP3
    const rawPcm = base64ToUint8Array(pcmBase64);
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

// ── Gemini TTS ───────────────────────────────────────────────────────────────

async function callGeminiTts(apiKey: string, voice: string, text: string): Promise<string | null> {
    const url = `${GEMINI_TTS_ENDPOINT}?key=${apiKey}`;
    const body = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                },
            },
            // NOTE: no `audioConfig` field — that's Google Cloud TTS's schema.
            // Gemini's generateContent endpoint returns LINEAR16 PCM @ 24kHz
            // by default for TTS; adding audioConfig trips a 400 "unknown
            // field". Persona round 11 console audit (2026-04-20) caught
            // this: three "Request failed, status 400" warnings per run.
        },
    };

    const response = await requestUrl({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Without throw:false, requestUrl auto-throws on 4xx/5xx with the
        // cryptic "Request failed, status 400" and discards the body. Let us
        // read the body so users see WHY Gemini rejected the payload.
        throw: false,
    });

    if (response.status !== 200) {
        throw new Error(`Gemini TTS error ${response.status}: ${response.text.slice(0, 300)}`);
    }

    // Validate response structure before accessing nested fields
    interface GeminiTtsResponse {
        candidates?: Array<{
            content?: {
                parts?: Array<{
                    inlineData?: { mimeType?: string; data?: string };
                }>;
            };
        }>;
    }
    const json = response.json as GeminiTtsResponse | null;
    if (!json || !Array.isArray(json.candidates) || json.candidates.length === 0) {
        return null; // unexpected structure — caller handles gracefully
    }
    const inlineData = json.candidates[0]?.content?.parts?.[0]?.inlineData;
    const data = inlineData?.data;
    // Accept any audio MIME type (Gemini returns audio/pcm, audio/wav, etc.)
    const mimeType = inlineData?.mimeType ?? '';
    if (typeof data !== 'string' || data.length === 0 || !mimeType.startsWith('audio')) {
        return null; // no valid audio payload — skip silently
    }
    return data;
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
 */
async function computeFingerprint(script: string, voice: string): Promise<string> {
    const raw = script + '\x00' + voice + '\x00' + GEMINI_TTS_ENDPOINT;
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
