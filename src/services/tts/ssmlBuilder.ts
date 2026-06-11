/**
 * SSML builder for the Cognitive Speech TTS engine (azure-audio plan D11/H6).
 *
 * Note text is UNTRUSTED (`&`, `<`, code, XML-ish markup, Markdown leftovers):
 * everything is XML-escaped into text nodes; the voice name is validated
 * against a strict Azure voice-name grammar (the cached `voices/list` catalog
 * powers the picker — this regex is the offline validation backstop); a
 * max-chars budget bounds a single request (the real-time endpoint caps at
 * ~10 min audio/request). Fails CLOSED on malformed input — never emits a
 * best-effort SSML document.
 *
 * Used ONLY by `cognitiveSpeechTtsEngine`.
 */

import { type Result, ok, err } from '../../core/result';

/**
 * Azure voice names: `<locale>-<Name>` (e.g. `en-US-AvaNeural`) with an
 * optional dialect subtag (e.g. `zh-CN-liaoning-XiaobeiNeural`) and an
 * optional `:Variant` suffix (e.g. `en-US-Ava:DragonHDLatestNeural`).
 */
const AZURE_VOICE_RE = /^[A-Za-z]{2,4}-[A-Za-z]{2,4}(-[A-Za-z0-9]+){1,2}(:[A-Za-z0-9]+)?$/;

/** XML 1.0 forbidden control characters (everything below 0x20 except TAB/LF/CR). */
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Per-request character budget. Narration chunking (`splitForTts`) produces
 * ~2–4k-char chunks, so this is generous headroom while staying far below the
 * endpoint's 10-min audio cap.
 */
export const MAX_SSML_TEXT_CHARS = 8000;

export function escapeXml(text: string): string {
    return text
        .replace(XML_INVALID_CHARS, '') // XML 1.0 cannot carry these even escaped
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Validate a voice name against the Azure grammar (offline backstop for the catalog). */
export function isValidAzureVoiceName(voice: string): boolean {
    return AZURE_VOICE_RE.test(voice);
}

/** Derive `xml:lang` from a voice name (`en-US-AvaNeural` → `en-US`). */
export function voiceLocale(voice: string): string | null {
    const m = /^([A-Za-z]{2,3}-[A-Za-z]{2,4})-/.exec(voice);
    return m ? m[1] : null;
}

/**
 * Build a single-voice SSML document. `lang` falls back to the voice's own
 * locale prefix. Fail-closed: empty text, over-budget text, or an invalid
 * voice name returns a typed error.
 */
export function buildSsml(text: string, voice: string, lang?: string): Result<string> {
    if (typeof text !== 'string') return err('empty-text');
    // Normalize BEFORE validating (rBv H4/M10): a string of only XML-forbidden
    // control characters must fail `empty-text`, not slip through and produce
    // an empty <voice> document after escaping strips them.
    const clean = text.replace(XML_INVALID_CHARS, '');
    if (!clean.trim()) return err('empty-text');
    if (clean.length > MAX_SSML_TEXT_CHARS) return err('text-too-long');
    if (typeof voice !== 'string' || !isValidAzureVoiceName(voice.trim())) return err('invalid-voice');
    const v = voice.trim();
    const locale = (lang && /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang.trim()) ? lang.trim() : null)
        ?? voiceLocale(v);
    if (!locale) return err('invalid-voice');
    const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}">` +
        `<voice name="${escapeXml(v)}">${escapeXml(clean)}</voice>` +
        `</speak>`;
    return ok(ssml);
}
