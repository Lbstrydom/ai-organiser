/**
 * Hash helpers for vector indexing. Uses Web Crypto API (available on both
 * desktop and mobile Obsidian, and in Node 18+ test environments).
 */

/**
 * Create a stable SHA-256 hash for content change detection.
 * Returns a hex-encoded string.
 */
export async function createContentHash(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}
