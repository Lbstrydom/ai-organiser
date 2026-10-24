/**
 * What a capture may touch. Built on the inbox sweep's guard, so the capture feature and the sweep
 * can never disagree about what is kept out. Pure and fail-closed.
 *
 * Order matters: sources AND destinations are judged BEFORE any content is read or any provider is
 * called.
 */
import { isInsideOrEqual, normalisePath, resolveProtectedFolders, type ProtectedSource } from '../../core/protectedPaths';
import { exclusionReason, type ExclusionReason, type SweepPolicy } from '../inboxSweep/sweepGuard';

/** A long transcript must not be excluded after it was paid for. */
export const MACHINE_TEXT_MIN_CAP = 60_000;

export type SetupProblemCode =
    | 'no-inbox'
    | 'inbox-protected'
    | 'inbox-output-root'
    | 'destination-protected'
    | 'destination-output-root'
    | 'destination-in-inbox';

export interface SetupProblem {
    code: SetupProblemCode;
    path: string;
}

/**
 * Setup validation. The inbox must not be (or sit inside, or contain) a protected folder or a plugin
 * output root; the destination root must not be protected, a plugin output root, or inside an inbox
 * folder (the sweep would then read the organised notes).
 */
export function validateCaptureSetup(
    inboxFolders: readonly string[],
    destinationRoot: string,
    protectedFolders: ProtectedSource,
    outputRoots: readonly string[],
): SetupProblem[] {
    const problems: SetupProblem[] = [];
    const inboxes = inboxFolders.map(normalisePath).filter((p) => p !== '');
    if (inboxes.length === 0) problems.push({ code: 'no-inbox', path: '' });
    const protectedList = resolveProtectedFolders(protectedFolders);
    const roots = outputRoots.map(normalisePath).filter((p) => p !== '');
    const overlaps = (a: string, b: string): boolean => isInsideOrEqual(a, b) || isInsideOrEqual(b, a);
    for (const inbox of inboxes) {
        if (protectedList.some((p) => overlaps(inbox, p))) problems.push({ code: 'inbox-protected', path: inbox });
        if (roots.some((r) => overlaps(inbox, r))) problems.push({ code: 'inbox-output-root', path: inbox });
    }
    const dest = normalisePath(destinationRoot);
    if (dest !== '') {
        if (protectedList.some((p) => overlaps(dest, p))) problems.push({ code: 'destination-protected', path: dest });
        if (roots.some((r) => overlaps(dest, r))) problems.push({ code: 'destination-output-root', path: dest });
        if (inboxes.some((i) => isInsideOrEqual(dest, i))) problems.push({ code: 'destination-in-inbox', path: dest });
    }
    return problems;
}

export type DestinationDecision = { ok: true; folder: string } | { ok: false; reason: 'outside-root' | 'protected' | 'output-root' | 'in-inbox' | 'missing' | 'no-root' };

/** May an organised note be created in `folder`? Every rule is checked; the first failure names itself. */
export function checkDestination(
    folder: string,
    destinationRoot: string,
    ctx: { protectedFolders: ProtectedSource; outputRoots: readonly string[]; inboxFolders: readonly string[]; exists: (folder: string) => boolean },
): DestinationDecision {
    const root = normalisePath(destinationRoot);
    const f = normalisePath(folder);
    if (root === '') return { ok: false, reason: 'no-root' };
    if (f === '' || !isInsideOrEqual(f, root)) return { ok: false, reason: 'outside-root' };
    if (resolveProtectedFolders(ctx.protectedFolders).some((p) => isInsideOrEqual(f, p))) return { ok: false, reason: 'protected' };
    if (ctx.outputRoots.some((r) => normalisePath(r) !== '' && isInsideOrEqual(f, r))) return { ok: false, reason: 'output-root' };
    if (ctx.inboxFolders.some((i) => normalisePath(i) !== '' && isInsideOrEqual(f, i))) return { ok: false, reason: 'in-inbox' };
    if (!ctx.exists(f)) return { ok: false, reason: 'missing' };
    return { ok: true, folder: f };
}

/**
 * A path-only judgement (an attachment, a folder name): the folder rules apply, and so do the keep-out
 * words, matched against the path itself (a file name can carry a client name).
 */
export function pathExclusion(path: string, policy: SweepPolicy): ExclusionReason | null {
    return exclusionReason(path, path, policy);
}

/**
 * Judge machine text (a transcript, digitised text) on the full text with the machine-text cap. Run
 * BEFORE the text is persisted or sent anywhere.
 */
export function machineTextExclusion(path: string, text: string, policy: SweepPolicy): ExclusionReason | null {
    return exclusionReason(path, text, { ...policy, maxNoteChars: Math.max(policy.maxNoteChars, MACHINE_TEXT_MIN_CAP) });
}

/**
 * The sweep policy, with every note the capture workflow still holds added as an exact-path
 * exclusion. With nothing held the SAME object is returned, so the feature being off (an empty
 * mirror) leaves the sweep byte-identical.
 */
export function withHeldPaths(policy: SweepPolicy, heldPaths: readonly string[]): SweepPolicy {
    if (heldPaths.length === 0) return policy;
    return { ...policy, excludedFolders: [...policy.excludedFolders, ...heldPaths] };
}
