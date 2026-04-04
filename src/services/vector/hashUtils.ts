/**
 * Hash helpers for vector indexing
 */

// eslint-disable-next-line import/no-nodejs-modules -- Node.js crypto for content hashing (available in Electron runtime)
import { createHash } from 'crypto';

/**
 * Create a stable MD5 hash for content change detection
 */
export function createContentHash(content: string): string {
    return createHash('md5').update(content, 'utf8').digest('hex');
}
