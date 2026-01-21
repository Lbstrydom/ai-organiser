/**
 * Hash helpers for vector indexing
 */

import { createHash } from 'crypto';

/**
 * Create a stable MD5 hash for content change detection
 */
export function createContentHash(content: string): string {
    return createHash('md5').update(content, 'utf8').digest('hex');
}
