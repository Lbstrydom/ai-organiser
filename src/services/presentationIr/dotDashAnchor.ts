/**
 * Dot-dash hidden-anchor codec (audit H5/H9/M18). The storyline `.md` carries each
 * slide's machine state (id/role/visual_data/evidence) in a hidden HTML comment.
 * Embedding raw JSON there is unsafe: a value containing `-->` (or `--`) breaks the
 * comment fence, and markdown metacharacters could leak. So the payload is ALWAYS
 * **base64-encoded** (mirrors `transcriptNoteService`'s G5 fix) and carries an
 * explicit **anchor schema version** so the format can evolve.
 *
 * Wire form: `<!-- aio-slide:1 <base64-utf8-json> -->`
 */
export const SLIDE_ANCHOR = 'aio-slide';
export const ANCHOR_VERSION = 1;

/** UTF-8 → base64 (chunked to avoid call-stack limits on large payloads). */
function utf8ToBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
}

function base64ToUtf8(b64: string): string {
    const binary = atob(b64.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/** Serialize a machine-state object to the hidden anchor comment. */
export function encodeAnchor(state: unknown): string {
    return `<!-- ${SLIDE_ANCHOR}:${ANCHOR_VERSION} ${utf8ToBase64(JSON.stringify(state))} -->`;
}

export type DecodedAnchor =
    | { ok: true; version: number; state: Record<string, unknown> }
    | { ok: false };

/** Match an anchor comment in a slide body and decode it. Fail-safe (never throws). */
const ANCHOR_RE = new RegExp(`<!--\\s*${SLIDE_ANCHOR}:(\\d+)\\s+([A-Za-z0-9+/=]+)\\s*-->`);

export function findAndDecodeAnchor(body: string): DecodedAnchor | null {
    const m = body.match(ANCHOR_RE);
    if (!m) return null; // no anchor present (caller treats the slide as fresh)
    try {
        const version = Number(m[1]);
        const parsed = JSON.parse(base64ToUtf8(m[2]));
        if (parsed && typeof parsed === 'object') {
            return { ok: true, version, state: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false }; // corrupt anchor — caller surfaces a typed error
    }
}
