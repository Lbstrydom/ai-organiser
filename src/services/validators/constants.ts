/**
 * Shared numeric thresholds for validators and auditors.
 * DD-8: No hard-coded values — all thresholds exported from here.
 */

/** Low-confidence threshold — warn if this fraction of items are low-confidence */
export const LOW_CONFIDENCE_WARN_RATIO = 0.5;

/** Allowed GTD contexts */
export const VALID_GTD_CONTEXTS = ['@office', '@home', '@call', '@computer', '@agenda', '@errand'] as const;

/** Transcript excerpt cap for audit prompts (chars) */
export const AUDIT_TRANSCRIPT_EXCERPT_CHARS = 5000;

/** Minutes audit timeout (ms) */
export const MINUTES_AUDIT_TIMEOUT_MS = 30_000;

/** Integration audit timeout (ms) */
export const INTEGRATION_AUDIT_TIMEOUT_MS = 20_000;

/** Integration output length ratio thresholds */
export const INTEGRATION_MIN_LENGTH_RATIO = 0.2;
export const INTEGRATION_MAX_LENGTH_RATIO = 3.0;

/** Original/pending content excerpt caps for integration audit (chars) */
export const AUDIT_ORIGINAL_EXCERPT_CHARS = 4000;
export const AUDIT_PENDING_EXCERPT_CHARS = 2000;

/** Embedded content loss threshold — warn if output retains less than this fraction of embeds */
export const EMBED_LOSS_THRESHOLD = 0.5;
