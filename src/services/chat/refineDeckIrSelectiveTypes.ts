/**
 * Type-only contract for the selective per-slide refine service.
 *
 * Lives in its own neutral module (no Obsidian, no service imports) so the
 * dependency direction stays clean: both the service
 * (`refineDeckIrSelective.ts`) and the i18n type module (`i18n/types.ts`)
 * import `RefineErrorCode` from here, instead of i18n reaching into a service
 * module (plan §7.2, audit-r3 M4).
 *
 * Error codes are encoded as the colon-prefix of the canonical `Result<T>`
 * error string ("<code>: <detail>") so the UI can localise by code without
 * forking the project's `Result` contract (plan §4.2, audit-r2 H2 + r3 H2).
 */

/** Single source of truth — the type and the runtime lookup set both derive
 *  from this array, so a new code can't be added in one place but not the
 *  other (audit L2). */
const CODES = [
    'aborted',
    'empty-selections',
    'duplicate-selection-index',
    'selection-out-of-range',
    'deck-too-large',
    'llm-call-failed',
    'malformed-json',
    'shape-mismatch',
    'duplicate-returned-index',
    'index-set-mismatch',
    'invalid-slide-schema',
    'invalid-deck-after-splice',
    'unexpected-exception',
] as const;

export type RefineErrorCode = typeof CODES[number];

/** Runtime lookup set — used by `parseRefineErrorCode` to validate a parsed
 *  prefix is a real code before trusting it. */
export const REFINE_ERROR_CODES: ReadonlySet<RefineErrorCode> = new Set(CODES);
