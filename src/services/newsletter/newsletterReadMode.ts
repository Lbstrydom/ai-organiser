/**
 * Newsletter read mode — what, if anything, counts as the reader having read a brief.
 *
 *   - `off`           nothing is collected or used (the default; byte-identical to before)
 *   - `explicit`      only the "Mark brief as read" command
 *   - `read-through`  the command, plus the Reading-view detector
 *
 * Pure and dependency-free, like `newsletterAudioMode`, so settings migration, the policy gate
 * and the UI can all import it without a cycle.
 */

export type NewsletterReadMode = 'off' | 'explicit' | 'read-through';

/** Every mode THIS build ships. A persisted value outside the set is coerced to `off`. */
export const SHIPPED_READ_MODES: readonly NewsletterReadMode[] = ['off', 'explicit', 'read-through'];

export const DEFAULT_READ_MODE: NewsletterReadMode = 'off';

export function isReadMode(value: unknown): value is NewsletterReadMode {
    return typeof value === 'string' && (SHIPPED_READ_MODES as readonly string[]).includes(value);
}

/** The effective mode. Fails closed to `off` on anything unrecognised. */
export function getReadMode(settings: { newsletterReadMode?: unknown }): NewsletterReadMode {
    return isReadMode(settings.newsletterReadMode) ? settings.newsletterReadMode : DEFAULT_READ_MODE;
}
