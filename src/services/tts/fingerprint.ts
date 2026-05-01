/**
 * Fingerprint — deterministic content hashing for idempotent output paths.
 *
 * Hard-requires Web Crypto API (`crypto.subtle.digest`). On all Obsidian
 * targets (Electron desktop, modern mobile WebViews) this is universally
 * available. If absent, throws a typed error so the caller surfaces a clear
 * Notice rather than silently degrading to a non-deterministic fallback
 * (which would break idempotency — duplicate MP3s for identical content).
 */

export class CryptoUnavailableError extends Error {
    readonly code = 'UNSUPPORTED_PLATFORM';
    constructor() {
        super('Web Crypto API (crypto.subtle.digest) is unavailable on this platform.');
        this.name = 'CryptoUnavailableError';
    }
}

/**
 * SHA-256 of the joined parts. Returns lowercase hex.
 *
 * Encoding is length-prefixed (audit M16) — each part is serialised as
 * `<utf8 byte length>:<utf8 bytes>` before concatenation, so that distinct
 * tuples cannot collide when a part contains the separator character. This
 * is robust under any input (including raw NUL bytes in note content).
 *
 * @throws {CryptoUnavailableError} if `crypto.subtle.digest` is missing.
 */
export async function sha256Hex(parts: string[]): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
        throw new CryptoUnavailableError();
    }
    const encoder = new TextEncoder();
    // Concatenate length-prefixed parts: "<n>:<bytes>" repeated.
    const segments: Uint8Array[] = [];
    let total = 0;
    for (const part of parts) {
        const bytes = encoder.encode(part);
        const header = encoder.encode(`${bytes.byteLength}:`);
        segments.push(header, bytes);
        total += header.byteLength + bytes.byteLength;
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const seg of segments) {
        buf.set(seg, offset);
        offset += seg.byteLength;
    }
    const hashBuffer = await subtle.digest('SHA-256', buf);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
