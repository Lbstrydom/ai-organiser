/**
 * Best-effort PII redaction utility (R3-M5, Gemini-r2-G3).
 *
 * Used by:
 *   - Failed-segment renderer for the rawExcerpt preview shown in warning callouts
 *   - Service-layer error-message sanitisation (provider messages sometimes
 *     contain user-content snippets)
 *
 * Strict cap-after-redact discipline: truncation happens AFTER redaction,
 * so PII can never sneak past the maxChars limit.
 */

const EMAIL_RE = /\b[\w._%+-]+@[\w.-]+\.\w{2,}\b/g;
const URL_RE = /\bhttps?:\/\/\S+/g;

// Phone matcher with word boundaries; requires ≥7 digits total to avoid
// false-positives on dates ("12-05-2026" = 7 but boundary-protected),
// version strings ("2.5.0"), ISBN-10, short IDs.
const PHONE_CANDIDATE_RE = /(?<!\d)\+?\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}(?!\d)/g;

function looksLikePhone(match: string): boolean {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return false;
    // Avoid pure date patterns like "12-05-2026" — heuristic: if every dash-
    // separated piece is ≤4 digits AND there are exactly 3 pieces, treat as
    // date-like and skip.
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(match.trim())) return false;
    // Skip version-like patterns "1.2.3" / "1.2.3.4"
    if (/^\d+\.\d+(\.\d+){1,3}$/.test(match.trim())) return false;
    return true;
}

export function redactPII(text: string, maxChars: number): string {
    if (!text) return '';
    let out = text
        .replace(EMAIL_RE, '[email]')
        .replace(URL_RE, '[url]')
        .replace(PHONE_CANDIDATE_RE, (match) => (looksLikePhone(match) ? '[phone]' : match));

    if (out.length > maxChars) {
        out = out.slice(0, Math.max(0, maxChars - 1)) + '…';
    }
    return out;
}
