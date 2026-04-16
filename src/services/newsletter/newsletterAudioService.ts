/**
 * Newsletter Audio Podcast Service
 *
 * Converts a Daily Brief text into a WAV audio file using the Gemini TTS API.
 * Uses hash-in-filename for idempotency (same content → same filename, avoiding
 * Windows file-locking issues with vault.modify on open files).
 */

import { App, normalizePath, requestUrl, TFile } from 'obsidian';
import { ensureFolderExists } from '../../utils/minutesUtils';

const GEMINI_TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';
const WAV_SAMPLE_RATE = 24000;
const WAV_CHANNELS = 1;
const WAV_BITS_PER_SAMPLE = 16;

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
    const fileName = `brief-${dateStr}-${shortFp}.wav`;
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

    // Decode base64 → PCM bytes → WAV
    const pcmBytes = base64ToUint8Array(pcmBase64);
    const wavBytes = pcmToWav(pcmBytes, WAV_SAMPLE_RATE, WAV_CHANNELS, WAV_BITS_PER_SAMPLE);

    // Write to vault
    try {
        await ensureFolderExists(app.vault, outputFolder);
        await vault.createBinary(filePath, wavBytes);

        // Prune any stale brief WAV files for the same date (different fingerprint)
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
            // Lock audio format to match pcmToWav() assumptions (LINEAR16 @ 24kHz).
            // Without audioConfig the API may return OPUS or a different sample rate,
            // producing a corrupt WAV file.
            audioConfig: {
                audioEncoding: 'LINEAR16',
                sampleRateHertz: WAV_SAMPLE_RATE,
            },
        },
    };

    const response = await requestUrl({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (response.status !== 200) {
        throw new Error(`Gemini TTS error ${response.status}: ${response.text.slice(0, 200)}`);
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

// ── WAV encoding ─────────────────────────────────────────────────────────────

/**
 * Wrap raw LINEAR16 PCM bytes in a WAV (RIFF) container.
 * All multi-byte values use Little-Endian byte order.
 */
function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): ArrayBuffer {
    const dataSize = pcm.byteLength;
    const blockAlign = channels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);           // ChunkSize (LE)
    writeAscii(view, 8, 'WAVE');

    // fmt sub-chunk
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);                      // Subchunk1Size = 16 for PCM (LE)
    view.setUint16(20, 1, true);                       // AudioFormat = 1 (PCM) (LE)
    view.setUint16(22, channels, true);                // NumChannels (LE)
    view.setUint32(24, sampleRate, true);              // SampleRate (LE)
    view.setUint32(28, byteRate, true);                // ByteRate (LE)
    view.setUint16(32, blockAlign, true);              // BlockAlign (LE)
    view.setUint16(34, bitsPerSample, true);           // BitsPerSample (LE)

    // data sub-chunk
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);                // Subchunk2Size (LE)

    // PCM samples
    new Uint8Array(buffer, headerSize).set(pcm);

    return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.codePointAt(i) ?? 0);
    }
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
    const pattern = new RegExp(String.raw`^brief-${dateStr}-([a-f0-9]{8})\.wav$`);
    for (const child of (folderFile as { children: unknown[] }).children) {
        if (!(child instanceof TFile)) continue;
        const m = pattern.exec(child.name);
        if (m && m[1] !== currentShortFp) {
            try {
                await app.fileManager.trashFile(child);
            } catch {
                // best-effort — stale file cleanup is non-critical
            }
        }
    }
}
