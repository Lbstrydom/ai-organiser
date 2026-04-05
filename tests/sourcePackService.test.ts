/**
 * Tests for NotebookLM Source Pack Service
 *
 * Tests for Phase 3: Service Orchestration
 * - Hashing utilities (string and binary)
 */

import {
    computeSHA256,
    computeBinarySHA256,
    computePackHash,
    hashNoteContent,
    generateShortId,
    hashesMatch,
    isValidSHA256
} from '../src/services/notebooklm/hashing';

describe('NotebookLM Hashing Utilities', () => {
    describe('computeSHA256', () => {
        it('should compute SHA256 hash of string content', async () => {
            const hash = await computeSHA256('Hello, World!');
            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should produce consistent hashes for same input', async () => {
            const hash1 = await computeSHA256('test content');
            const hash2 = await computeSHA256('test content');
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different input', async () => {
            const hash1 = await computeSHA256('content A');
            const hash2 = await computeSHA256('content B');
            expect(hash1).not.toBe(hash2);
        });

        it('should handle empty string', async () => {
            const hash = await computeSHA256('');
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });

        it('should handle unicode content', async () => {
            const hash = await computeSHA256('Hello 世界 🌍');
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });
    });

    describe('computeBinarySHA256', () => {
        it('should compute SHA256 hash of ArrayBuffer', async () => {
            const encoder = new TextEncoder();
            const buffer = encoder.encode('Hello, World!').buffer as ArrayBuffer;
            const hash = await computeBinarySHA256(buffer);

            // Should match string hash for same content
            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should compute SHA256 hash of Uint8Array', async () => {
            const encoder = new TextEncoder();
            const uint8 = encoder.encode('Hello, World!');
            const hash = await computeBinarySHA256(uint8);

            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should handle empty buffer', async () => {
            const buffer = new ArrayBuffer(0);
            const hash = await computeBinarySHA256(buffer);
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });

        it('should produce consistent hashes for same binary content', async () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const hash1 = await computeBinarySHA256(data);
            const hash2 = await computeBinarySHA256(data);
            expect(hash1).toBe(hash2);
        });
    });

    describe('computePackHash', () => {
        it('should compute deterministic hash from entry hashes', async () => {
            const entryHashes = ['abc123', 'def456', 'ghi789'];
            const packHash = await computePackHash(entryHashes);
            expect(packHash).toHaveLength(64);
        });

        it('should produce same hash regardless of input order', async () => {
            const hashes1 = ['abc', 'def', 'ghi'];
            const hashes2 = ['ghi', 'abc', 'def'];

            expect(await computePackHash(hashes1)).toBe(await computePackHash(hashes2));
        });

        it('should produce different hash when content changes', async () => {
            const hashes1 = ['abc', 'def'];
            const hashes2 = ['abc', 'xyz'];

            expect(await computePackHash(hashes1)).not.toBe(await computePackHash(hashes2));
        });

        it('should handle empty array', async () => {
            const packHash = await computePackHash([]);
            expect(packHash).toHaveLength(64);
        });
    });

    describe('hashNoteContent', () => {
        it('should return both full hash and short ID', async () => {
            const result = await hashNoteContent('test content');
            expect(result.sha256).toHaveLength(64);
            expect(result.shortId).toHaveLength(8);
            expect(result.sha256.startsWith(result.shortId)).toBe(true);
        });
    });

    describe('generateShortId', () => {
        it('should generate default 8-character ID', async () => {
            const hash = await computeSHA256('test');
            const shortId = generateShortId(hash);
            expect(shortId).toHaveLength(8);
        });

        it('should respect custom length', async () => {
            const hash = await computeSHA256('test');
            expect(generateShortId(hash, 6)).toHaveLength(6);
            expect(generateShortId(hash, 12)).toHaveLength(12);
        });
    });

    describe('hashesMatch', () => {
        it('should return true for matching hashes', () => {
            expect(hashesMatch('abc123', 'abc123')).toBe(true);
        });

        it('should be case-insensitive', () => {
            expect(hashesMatch('ABC123', 'abc123')).toBe(true);
            expect(hashesMatch('AbC123', 'aBc123')).toBe(true);
        });

        it('should return false for different hashes', () => {
            expect(hashesMatch('abc123', 'xyz789')).toBe(false);
        });
    });

    describe('isValidSHA256', () => {
        it('should validate correct SHA256 hashes', async () => {
            const validHash = await computeSHA256('test');
            expect(isValidSHA256(validHash)).toBe(true);
        });

        it('should reject invalid hashes', () => {
            expect(isValidSHA256('not-a-hash')).toBe(false);
            expect(isValidSHA256('abc')).toBe(false);
            expect(isValidSHA256('')).toBe(false);
            expect(isValidSHA256('g'.repeat(64))).toBe(false); // Invalid hex char
        });
    });
});
