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
import { itemKeys, reportedMatch } from './sweepItemIdentity';
import { logger } from '../../utils/logger';
import { looksLikeHandback } from '../aiWorkspaces/handoffParser';
import { DEFAULT_SWEEP_CONTEXTS } from './sweepContexts';

export interface NoteProposals {
    path: string;
    contentHash: string;
    items: SweepItem[];
    /** Aligned with `items`: true when the item was already added to the sweep report from this note */
    reported?: boolean[];
    /** Aligned with `items`: true when the item looks like one already added (same quoted line, similar wording) but is not the same wording */
    similar?: boolean[];
    dropped: number;
    truncated: boolean;
}

export interface SweepRunResult {
    notes: NoteProposals[];
    excluded: Partial<Record<ExclusionReason, number>>;
    skippedSwept: number;
    failed: number;
    cancelled: boolean;
    /** The one context set the whole run used: prompt, parser and the review all follow it */
    contexts: readonly string[];
    /** AI hand-back notes the sweep left alone (they have their own review) */
    skippedHandbacks?: number;
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
    /** The contexts this run offers; read once at its start. Absent: the built-in set. */
    contexts?(): readonly string[];
    /** True while AI workspaces are on: AI hand-back notes are then left to their own review. Absent: the sweep reads every note, as it always did. */
    skipHandbacks?(): boolean;
    /** Identity keys of the items already reported from this note (absent: none are known) */
    reportedKeys?(path: string): ReadonlySet<string>;
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
export async function estimateSweep(deps: SweepDeps, options: Pick<SweepOptions, 'maxNotes' | 'maxChars'>): Promise<Result<{ notes: number; chars: number }>> {
    try {
        return ok(await estimateUnguarded(deps, options));
    } catch (e) {
        logger.error('Sweep', 'Estimate failed', e);
        return err('unknown');
    }
}

async function estimateUnguarded(deps: SweepDeps, options: Pick<SweepOptions, 'maxNotes' | 'maxChars'>): Promise<{ notes: number; chars: number }> {
    let notes = 0;
    let chars = 0;
    for (const path of deps.candidates()) {
        if (notes >= options.maxNotes) break;
        const text = await deps.readText(path);
        if (text === null) continue;
        const policy = deps.policy();
        const snap = await buildSnapshot(path, text, await policyRevisionOf(policy));
        const judged = guardSnapshot(snap, { ...policy, maxNoteChars: Math.max(policy.maxNoteChars, options.maxChars) }, snap.policyRevision);
        if (!judged.allowed || isSwept(deps.ledger(), path, snap.contentHash) || isSkippedHandback(deps, text)) continue;
        notes++;
        chars += Math.min(text.length, options.maxChars);
    }
    return { notes, chars };
}

/** An AI hand-back is left to its own review, but only while AI workspaces are on; otherwise the sweep reads it like any note. */
function isSkippedHandback(deps: SweepDeps, text: string): boolean {
    return deps.skipHandbacks?.() === true && looksLikeHandback(text);
}

/** A policy and its revision that were the same before and after the revision was computed. */
async function coherentPolicy(deps: SweepDeps): Promise<{ policy: SweepPolicy; revision: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const policy = deps.policy();
        const revision = await policyRevisionOf(policy);
        if (JSON.stringify(deps.policy()) === JSON.stringify(policy)) return { policy, revision };
    }
    // Settings keep changing: use the latest and let the pre-call check catch any difference.
    const policy = deps.policy();
    return { policy, revision: await policyRevisionOf(policy) };
}

/** Capture and judge one note against the policy as it is right now. */
async function capture(deps: SweepDeps, path: string): Promise<{ result: ReturnType<typeof guardSnapshot>; hash: string } | null> {
    const text = await deps.readText(path);
    if (text === null) return null;
    const { policy, revision } = await coherentPolicy(deps);
    const snap = await buildSnapshot(path, text, revision);
    return { result: guardSnapshot(snap, policy, revision), hash: snap.contentHash };
}

export async function runSweep(deps: SweepDeps, options: SweepOptions): Promise<Result<SweepRunResult>> {
    // A thrown dependency (a vault read, the model call) is a typed failure, never a rejection past the contract.
    try {
        return await runSweepUnguarded(deps, options);
    } catch (e) {
        if (options.signal?.aborted) return err('cancelled');
        logger.error('Sweep', 'Sweep failed', e);
        return err('unknown');
    }
}

async function runSweepUnguarded(deps: SweepDeps, options: SweepOptions): Promise<Result<SweepRunResult>> {
    // One immutable set per run: a setting changed mid-run does not change what the model was told or what the review offers.
    const contexts: readonly string[] = [...(deps.contexts ? deps.contexts() : DEFAULT_SWEEP_CONTEXTS)];
    const out: SweepRunResult = { notes: [], excluded: {}, skippedSwept: 0, failed: 0, cancelled: false, contexts };
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
        // An AI hand-back has its own review; its lines must not come back here as tasks.
        if (isSkippedHandback(deps, judged.result.snapshot.text)) { out.skippedHandbacks = (out.skippedHandbacks ?? 0) + 1; continue; }

        // Immediately before the call the policy and the path must be what they were when the note was
        // judged. A snapshot that fails this is captured and judged again, and the NEW snapshot must pass
        // the same check before anything is sent: no model call without a passing pre-call validation.
        let guarded: GuardedSnapshot | null = judged.result.snapshot;
        let verified = false;
        for (let attempt = 0; attempt < 3 && guarded && !verified; attempt++) {
            const { policy, revision } = await coherentPolicy(deps);
            const here = deps.currentPath ? deps.currentPath(guarded.path) : guarded.path;
            if (here && JSON.stringify(deps.policy()) === JSON.stringify(policy) && stillAllowed(guarded, policy, revision, here)) { verified = true; break; }
            judged = await capture(deps, here ?? path);
            if (!judged) { out.failed++; guarded = null; break; }
            if (!judged.result.allowed) { out.excluded[judged.result.reason] = (out.excluded[judged.result.reason] ?? 0) + 1; guarded = null; break; }
            guarded = judged.result.snapshot;
        }
        if (!guarded) continue;
        if (!verified) { out.excluded.unknown = (out.excluded.unknown ?? 0) + 1; continue; }
        // The note may have been captured again above; the hand-back rule applies to the text actually about to be sent.
        if (isSkippedHandback(deps, guarded.text)) { out.skippedHandbacks = (out.skippedHandbacks ?? 0) + 1; continue; }

        const { truncated } = promptText(guarded, options.maxChars);
        const answer = await deps.complete(buildSweepPrompt(guarded, options.maxChars, contexts), options.signal);
        if (!answer.ok) {
            if (options.signal?.aborted) { out.cancelled = true; break; }
            out.failed++;
            continue;
        }
        const parsed = parseSweepResponse(answer.value, promptText(guarded, options.maxChars).text, contexts);
        // An answer we cannot read is a failure for this note, never "nothing to do": it stays unswept.
        if (parsed.malformed) { out.failed++; continue; }
        const known = deps.reportedKeys?.(guarded.path);
        const matches = parsed.items.map((item) => (known ? reportedMatch(known, itemKeys(item)) : null));
        const reported = matches.map((m) => m === 'exact');
        const similar = matches.map((m) => m === 'similar');
        out.notes.push({ path: guarded.path, contentHash: guarded.contentHash, items: parsed.items, reported, similar, dropped: parsed.dropped, truncated });
    }
    return out.cancelled && out.notes.length === 0 && out.failed === 0 ? err('cancelled') : ok(out);
}
