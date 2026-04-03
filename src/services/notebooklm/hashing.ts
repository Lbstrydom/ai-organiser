/**
 * Hashing Utilities for NotebookLM Source Packs
 * 
 * Provides SHA256 hashing for note content and pack content to:
 * - Detect changes in notes across revisions
 * - Generate stable short IDs for note anchors
 * - Compute pack-level hashes for revision management
 */

import { createHash } from 'crypto';

/**
 * Compute SHA256 hash of a string
 * @param content Content to hash
 * @returns Hex-encoded SHA256 hash
 */
export function computeSHA256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generate a short ID from a SHA256 hash
 * @param sha256 Full SHA256 hash (64 hex chars)
 * @param length Length of short ID (default: 8)
 * @returns Short ID (first N characters of hash)
 */
export function generateShortId(sha256: string, length: number = 8): string {
    return sha256.substring(0, length);
}

/**
 * Compute hash for a note's sanitised content
 * @param content Sanitised note content
 * @returns Object with full hash and short ID
 */
export function hashNoteContent(content: string): { sha256: string; shortId: string } {
    const sha256 = computeSHA256(content);
    const shortId = generateShortId(sha256);
    return { sha256, shortId };
}

/**
 * Compute deterministic pack-level hash from ordered entry hashes
 * 
 * This ensures:
 * - Content changes trigger new revision
 * - Order changes trigger new revision
 * - Only metadata changes (like mtime) do NOT trigger new revision
 * 
 * @param entryHashes Array of note content hashes (in pack order)
 * @returns Pack hash
 */
export function computePackHash(entryHashes: string[]): string {
    // Sort hashes to create deterministic ordering
    const sortedHashes = [...entryHashes].sort((a, b) => a.localeCompare(b));
    
    // Concatenate and hash
    const concatenated = sortedHashes.join('|');
    return computeSHA256(concatenated);
}

/**
 * Check if two hashes match (case-insensitive)
 * @param hash1 First hash
 * @param hash2 Second hash
 * @returns True if hashes match
 */
export function hashesMatch(hash1: string, hash2: string): boolean {
    return hash1.toLowerCase() === hash2.toLowerCase();
}

/**
 * Validate SHA256 hash format
 * @param hash Hash string to validate
 * @returns True if valid 64-char hex string
 */
export function isValidSHA256(hash: string): boolean {
    return /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Compute SHA256 hash of binary data (ArrayBuffer or Uint8Array)
 * @param data Binary data to hash
 * @returns Hex-encoded SHA256 hash
 */
export function computeBinarySHA256(data: ArrayBuffer | Uint8Array): string {
    const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return createHash('sha256').update(buffer).digest('hex');
}
