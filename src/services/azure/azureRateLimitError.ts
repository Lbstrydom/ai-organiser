/**
 * Typed transport error for the Azure rate-limit path (brand: azure-429-throttling).
 *
 * Raised by the shared transport when a request cannot proceed for a rate-limit
 * reason that the retry loop should NOT keep retrying. Carries a stable `kind` so
 * the UI boundary can map it to a localized Notice (`formatAzureRateLimitNotice`)
 * — the transport layer never emits user-facing English.
 */
export type AzureRateLimitErrorKind = 'tpm-exceeded' | 'queue-full';

export class AzureRateLimitError extends Error {
    readonly kind: AzureRateLimitErrorKind;
    /** Deployment per-minute token limit (TPM), when known. */
    readonly limitTokens?: number;
    /** Conservative estimate of tokens this request needs, when known. */
    readonly estTokens?: number;

    constructor(kind: AzureRateLimitErrorKind, opts: { limitTokens?: number; estTokens?: number; message?: string } = {}) {
        super(opts.message ?? `Azure rate limit: ${kind}`);
        this.name = 'AzureRateLimitError';
        this.kind = kind;
        this.limitTokens = opts.limitTokens;
        this.estTokens = opts.estTokens;
    }
}

/** Narrowing helper (also robust across bundle/realm boundaries via name + kind). */
export function isAzureRateLimitError(e: unknown): e is AzureRateLimitError {
    return e instanceof AzureRateLimitError
        || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AzureRateLimitError'
            && typeof (e as { kind?: unknown }).kind === 'string');
}
