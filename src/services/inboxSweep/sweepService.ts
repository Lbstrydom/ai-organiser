/**
 * Inbox sweep: pick notes, guard them, extract commitments, return proposals. Nothing here writes a
 * note; the review modal and the report writer own what happens next.
 *
 * Flow, each stage a separate function with a typed hand-off:
 *   candidate notes -> snapshot -> guard (BEFORE any model call) -> prompt -> extraction -> proposals
 */
import { Result, ok, err } from '../../core/result';
import { buildSweepPrompt, parseSweepResponse, promptText, type SweepItem } from '../prompts/sweepPrompts';
import { buildSnapshot } from './noteSnapshot';
import { guardSnapshot, policyRevisionOf, stillAllowed, type ExclusionReason, type GuardedSnapshot, type SweepPolicy } from './sweepGuard';
import { isSwept, type SweepLedger } from './sweepLedger';

export interface NoteProposals {
    path: string;
    contentHash: string;
    items: SweepItem[];
    dropped: number;
    truncated: boolean;
}

export interface SweepRunResult {
    notes: NoteProposals[];
    excluded: Partial<Record<ExclusionReason, number>>;
    skippedSwept: number;
    failed: number;
    cancelled: boolean;
}

export interface SweepDeps {
    /** Vault paths of notes in the chosen inbox folders, newest first */
    candidates(): string[];
    readText(path: string): Promise<string | null>;
    /** One model call; the plugin provides it, tests fake it */
    complete(prompt: string, signal?: AbortSignal): Promise<Result<string>>;
    /** The CURRENT policy; read again for every note and before every call */
    policy(): SweepPolicy;
    ledger(): SweepLedger;
    /** True when the path is still where the snapshot said it was (a rename mid-run changes it) */
    currentPath?(path: string): string | null;
}

export interface SweepOptions {
    maxNotes: number;
    maxChars: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, path: string) => void;
}

/** How many notes a run would send and roughly how many characters, for the cost confirmation. */
export async function estimateSweep(deps: SweepDeps, options: Pick<SweepOptions, 'maxNotes' | 'maxChars'>): Promise<{ notes: number; chars: number }> {
    let notes = 0;
    let chars = 0;
    for (const path of deps.candidates()) {
        if (notes >= options.maxNotes) break;
        const text = await deps.readText(path);
        if (text === null) continue;
        const policy = deps.policy();
        const snap = await buildSnapshot(path, text, await policyRevisionOf(policy));
        const judged = guardSnapshot(snap, { ...policy, maxNoteChars: Math.max(policy.maxNoteChars, options.maxChars) }, snap.policyRevision);
        if (!judged.allowed || isSwept(deps.ledger(), path, snap.contentHash)) continue;
        notes++;
        chars += Math.min(text.length, options.maxChars);
    }
    return { notes, chars };
}

/** Capture and judge one note against the policy as it is right now. */
async function capture(deps: SweepDeps, path: string): Promise<{ result: ReturnType<typeof guardSnapshot>; hash: string } | null> {
    const text = await deps.readText(path);
    if (text === null) return null;
    const policy = deps.policy();
    const revision = await policyRevisionOf(policy);
    const snap = await buildSnapshot(path, text, revision);
    return { result: guardSnapshot(snap, policy, revision), hash: snap.contentHash };
}

export async function runSweep(deps: SweepDeps, options: SweepOptions): Promise<Result<SweepRunResult>> {
    const out: SweepRunResult = { notes: [], excluded: {}, skippedSwept: 0, failed: 0, cancelled: false };
    const candidates = deps.candidates();
    let processed = 0;
    for (const path of candidates) {
        if (options.signal?.aborted) { out.cancelled = true; break; }
        if (out.notes.length + out.failed >= options.maxNotes) break;
        options.onProgress?.(processed++, candidates.length, path);

        let judged = await capture(deps, path);
        if (!judged) { out.failed++; continue; }
        if (!judged.result.allowed) { out.excluded[judged.result.reason] = (out.excluded[judged.result.reason] ?? 0) + 1; continue; }
        if (isSwept(deps.ledger(), path, judged.hash)) { out.skippedSwept++; continue; }

        // Immediately before the call: the policy and the path must be what they were when it was judged.
        let guarded: GuardedSnapshot = judged.result.snapshot;
        const policy = deps.policy();
        const revision = await policyRevisionOf(policy);
        const here = deps.currentPath ? deps.currentPath(path) : path;
        if (!here || !stillAllowed(guarded, policy, revision, here)) {
            judged = await capture(deps, here ?? path);
            if (!judged) { out.failed++; continue; }
            if (!judged.result.allowed) { out.excluded[judged.result.reason] = (out.excluded[judged.result.reason] ?? 0) + 1; continue; }
            guarded = judged.result.snapshot;
        }

        const { truncated } = promptText(guarded, options.maxChars);
        const answer = await deps.complete(buildSweepPrompt(guarded, options.maxChars), options.signal);
        if (!answer.ok) {
            if (options.signal?.aborted) { out.cancelled = true; break; }
            out.failed++;
            continue;
        }
        const parsed = parseSweepResponse(answer.value, promptText(guarded, options.maxChars).text);
        out.notes.push({ path: guarded.path, contentHash: guarded.contentHash, items: parsed.items, dropped: parsed.dropped, truncated });
    }
    return out.cancelled && out.notes.length === 0 && out.failed === 0 ? err('cancelled') : ok(out);
}
