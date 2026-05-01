/**
 * TTS chunker — splits long text into TTS-sized chunks.
 *
 * Extracted from newsletter audio service (March 2026) so both narration and
 * newsletter feeds use the same chunking logic. Single source of truth for
 * `TTS_CHUNK_CHAR_TARGET` / `TTS_CHUNK_CHAR_MAX`.
 *
 * Why these specific sizes: most neural TTS models lose energy / expressiveness
 * the further they generate (attention weights decay over long sequences).
 * Targeting ~90s of audio per chunk (≈ 150 wpm × 1.5min × ~5 chars/word) keeps
 * each generation in the model's steady-state range.
 */

export const TTS_CHUNK_CHAR_TARGET = 1100;
export const TTS_CHUNK_CHAR_MAX = 1800;

/** Normalise line endings so paragraph splitting is platform-agnostic (audit M8). */
function normaliseNewlines(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Split a string into hard-capped substrings, breaking at word boundaries
 *  where possible. Used as the last-resort fallback to enforce `max` for
 *  text with no sentence terminators. */
function hardSplit(text: string, max: number): string[] {
    if (text.length <= max) return [text];
    const out: string[] = [];
    let remaining = text;
    while (remaining.length > max) {
        // Look for a whitespace boundary in the last 10% of the window
        const lookback = Math.max(1, Math.floor(max * 0.1));
        const window = remaining.slice(0, max);
        const lastSpace = window.lastIndexOf(' ', max);
        const cut = (lastSpace >= max - lookback && lastSpace > 0) ? lastSpace : max;
        out.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining) out.push(remaining);
    return out.filter(Boolean);
}

/**
 * Split text into TTS-sized chunks. Splits on paragraph breaks first, then
 * sentence boundaries for paragraphs that exceed `max` on their own, then
 * word boundaries for sentences/blocks with no terminator. **Every emitted
 * chunk is guaranteed to be ≤ `max` characters (audit H7 fix).** Short
 * input (≤ `target`) passes through unchunked.
 */
export function splitForTts(
    text: string,
    target: number = TTS_CHUNK_CHAR_TARGET,
    max: number = TTS_CHUNK_CHAR_MAX,
): string[] {
    const trimmed = normaliseNewlines(text).trim();
    if (!trimmed) return [];
    if (trimmed.length <= target) return [trimmed];

    const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';

    const flush = (): void => {
        if (current) {
            chunks.push(current);
            current = '';
        }
    };

    for (const para of paragraphs) {
        if (para.length > max) {
            flush();
            chunks.push(...splitParagraphIntoSentences(para, target, max));
            continue;
        }
        const candidate = current ? `${current}\n\n${para}` : para;
        if (candidate.length > target && current) {
            flush();
            current = para;
        } else {
            current = candidate;
        }
    }
    flush();
    return chunks.length > 0 ? chunks : [trimmed];
}

/**
 * Sentence-level fallback for paragraphs exceeding `max`. Splits on punctuation,
 * packs sentences against `target`, and hard-caps any single sentence > `max`
 * by word-boundary slicing. **Every output chunk is ≤ `max` (audit H7 fix).**
 */
export function splitParagraphIntoSentences(
    paragraph: string,
    target: number = TTS_CHUNK_CHAR_TARGET,
    max: number = TTS_CHUNK_CHAR_MAX,
): string[] {
    const sentences = paragraph.match(/(?:[^.!?]+[.!?]+(?:\s+|$))|(?:[^.!?]+$)/g) ?? [paragraph];
    const chunks: string[] = [];
    let current = '';

    const flush = (): void => {
        if (current) {
            chunks.push(current);
            current = '';
        }
    };

    for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;

        // Single-sentence bigger than max → hard-split at word boundaries
        if (s.length > max) {
            flush();
            chunks.push(...hardSplit(s, max));
            continue;
        }

        const candidate = current ? `${current} ${s}` : s;
        if (candidate.length > target && current) {
            flush();
            current = s;
        } else {
            current = candidate;
        }
    }
    flush();
    return chunks;
}
