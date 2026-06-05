/**
 * UI-boundary mapper (azure-429-throttling, audit R2-H5): turns a transport-layer
 * `AzureRateLimitError` into a localized Notice string. ONE seam, covering EVERY
 * error `kind`. Returns `null` for any non-Azure-rate-limit error so the caller
 * keeps its own message. The transport layer never emits user-facing English —
 * localization happens here.
 */

import type { Translations } from '../../i18n/types';
import { isAzureRateLimitError } from './azureRateLimitError';

/** Compact a token count to a `~10k` style figure for the message. */
function fmtTokens(n: number | undefined): string {
    if (n == null || !Number.isFinite(n)) return '?';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export function formatAzureRateLimitNotice(error: unknown, t: Translations): string | null {
    if (!isAzureRateLimitError(error)) return null;
    const m = t.azureRateLimit;
    switch (error.kind) {
        case 'tpm-exceeded':
            return m.tpmExceeded
                .replace('{est}', fmtTokens(error.estTokens))
                .replace('{limit}', fmtTokens(error.limitTokens));
        case 'queue-full':
            return m.queueFull;
        default:
            return null;
    }
}
