/**
 * The destructive commit barrier: the last gate before the local file is trashed. Pure.
 *
 * Every condition must hold or the file is NOT trashed and the operation stays at `verified` with
 * the first failing reason shown to the user:
 *  1. every approved referrer has been rewritten (a skipped or conflicted one blocks the trash);
 *  2. the captured Drive file still matches a fresh listing, and the local source still matches its fingerprint;
 *  3. protection holds for the source and every rewritten referrer;
 *  4. a fresh authoritative reference scan finds no remaining local reference and no coverage failure;
 *  5. no vault event during the check invalidated it.
 */
export type BarrierReason =
    | 'referrer-not-done'
    | 'remote-mismatch'
    | 'source-changed'
    | 'protected'
    | 'still-referenced'
    | 'scan-incomplete'
    | 'vault-changed';

export type ReferrerStatus = 'pending' | 'done' | 'conflict' | 'skipped';

export interface BarrierInput {
    referrers: ReadonlyArray<{ path: string; status: ReferrerStatus }>;
    remoteMatches: boolean;
    sourceMatches: boolean;
    /** False when the source or any referrer is in a protected folder */
    protectionOk: boolean;
    /** From the fresh authoritative scan */
    remainingReferences: number;
    coverageFailures: number;
    /** Vault events seen while the scan ran that the check did not account for */
    unaccountedEvents: number;
}

export type BarrierResult = { ok: true } | { ok: false; reason: BarrierReason; detail?: string };

/** A usable count is a finite, non-negative integer. Anything else (NaN, negative, missing) is not evidence of "none". */
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

export function evaluateBarrier(input: BarrierInput): BarrierResult {
    const open = input.referrers.find((r) => r.status !== 'done');
    if (open) return { ok: false, reason: 'referrer-not-done', detail: open.path };
    if (!input.remoteMatches) return { ok: false, reason: 'remote-mismatch' };
    if (!input.sourceMatches) return { ok: false, reason: 'source-changed' };
    if (!input.protectionOk) return { ok: false, reason: 'protected' };
    if (!isCount(input.coverageFailures) || !isCount(input.remainingReferences) || !isCount(input.unaccountedEvents)) return { ok: false, reason: 'scan-incomplete' };
    if (input.coverageFailures > 0) return { ok: false, reason: 'scan-incomplete' };
    if (input.remainingReferences > 0) return { ok: false, reason: 'still-referenced', detail: String(input.remainingReferences) };
    if (input.unaccountedEvents > 0) return { ok: false, reason: 'vault-changed' };
    return { ok: true };
}
