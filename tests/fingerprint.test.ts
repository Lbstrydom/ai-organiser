/**
 * Fingerprint tests — deterministic SHA-256 + crypto-unavailable fallback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256Hex, CryptoUnavailableError } from '../src/services/tts/fingerprint';

describe('sha256Hex', () => {
    it('returns deterministic hex for known input', async () => {
        const h1 = await sha256Hex(['hello', 'world']);
        const h2 = await sha256Hex(['hello', 'world']);
        expect(h1).toBe(h2);
        // Always a 64-char lowercase hex string
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different hashes for different inputs', async () => {
        const h1 = await sha256Hex(['a', 'b']);
        const h2 = await sha256Hex(['a', 'c']);
        expect(h1).not.toBe(h2);
    });

    it('joins parts with NUL — order matters', async () => {
        const h1 = await sha256Hex(['a', 'b']);
        const h2 = await sha256Hex(['b', 'a']);
        expect(h1).not.toBe(h2);
    });

    it('handles empty input', async () => {
        const h = await sha256Hex([]);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('length-prefixed encoding distinguishes ambiguous tuples (audit M16)', async () => {
        // Without length-prefix, ['a:b', 'c'] joined as "a:bNULc" looked the same
        // as ['a', 'b:c'] under a separator-only encoding. With length prefixing,
        // they hash to different values. The new encoding format is "<n>:<bytes>"
        // per part, so any prefix collision must be detected.
        const h1 = await sha256Hex(['a:b', 'c']);
        const h2 = await sha256Hex(['a', 'b:c']);
        expect(h1).not.toBe(h2);
    });

    it('handles parts containing the separator character', async () => {
        // Audio narration passes file paths + spoken text — both can contain ":"
        const h1 = await sha256Hex(['Notes/test:case.md', 'Hello']);
        const h2 = await sha256Hex(['Notes/test', 'case.md', 'Hello']);
        expect(h1).not.toBe(h2);
    });

    it('handles parts containing NUL characters', async () => {
        // NUL bytes in input are now safe (length-prefixed)
        const h = await sha256Hex(['part one\x00with nul', 'part two']);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('sha256Hex when crypto.subtle is unavailable', () => {
    let originalCrypto: typeof globalThis.crypto;

    beforeEach(() => {
        originalCrypto = globalThis.crypto;
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    });

    it('throws CryptoUnavailableError when crypto.subtle is missing', async () => {
        Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
        await expect(sha256Hex(['x'])).rejects.toBeInstanceOf(CryptoUnavailableError);
    });

    it('throws when crypto.subtle.digest is not a function', async () => {
        Object.defineProperty(globalThis, 'crypto', {
            value: { subtle: { digest: 'not a function' } },
            configurable: true,
        });
        await expect(sha256Hex(['x'])).rejects.toBeInstanceOf(CryptoUnavailableError);
    });
});
