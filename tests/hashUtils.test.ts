/**
 * Hash Utils Tests
 * Verifies stable MD5 hashing for change detection
 */

import { describe, it, expect } from 'vitest';
import { createContentHash } from '../src/services/vector/hashUtils';

describe('createContentHash', () => {
  it('should generate a stable MD5 hash', () => {
    expect(createContentHash('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('should return the same hash for identical content', () => {
    const hash1 = createContentHash('same content');
    const hash2 = createContentHash('same content');
    expect(hash1).toBe(hash2);
  });

  it('should return different hashes for different content', () => {
    const hash1 = createContentHash('content a');
    const hash2 = createContentHash('content b');
    expect(hash1).not.toBe(hash2);
  });
});
