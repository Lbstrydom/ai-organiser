/**
 * Hash Utils Tests
 * Verifies stable SHA-256 hashing for change detection
 */

import { createContentHash } from '../src/services/vector/hashUtils';

describe('createContentHash', () => {
  it('should generate a stable SHA-256 hash', async () => {
    // SHA-256 of "hello"
    expect(await createContentHash('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should return the same hash for identical content', async () => {
    const hash1 = await createContentHash('same content');
    const hash2 = await createContentHash('same content');
    expect(hash1).toBe(hash2);
  });

  it('should return different hashes for different content', async () => {
    const hash1 = await createContentHash('content a');
    const hash2 = await createContentHash('content b');
    expect(hash1).not.toBe(hash2);
  });
});
