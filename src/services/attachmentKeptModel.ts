/**
 * What to tell the user about a file the delete-time re-check kept, and what they can do next.
 *
 * Pure view-model: `describeKept` turns an `Eligibility` (with its blockers) into typed items and
 * typed actions; the panel only maps them to words and buttons. One exhaustive switch over
 * `IneligibleReason`, so a new reason cannot ship without a card for it.
 */
import { isProtectedPath } from '../core/protectedPaths';
import type { CoverageFailure } from './embedScanService';
import type { BlockerRef, Eligibility } from './attachmentEligibility';

export type KeptAction =
    | { kind: 'open-note'; path: string }
    | { kind: 'open-canvas'; path: string }
    | { kind: 'open-file'; path: string }
    | { kind: 'remove-link-and-delete' }
    | { kind: 'enable-link-removal' }
    | { kind: 'scan-again' };

export type KeptItem =
    | { type: 'referenced'; ref: BlockerRef; protectedReferrer: boolean }
    /** Referenced, but the check could not say by what (should not happen; still says something true) */
    | { type: 'referenced-unknown'; count: number }
    | { type: 'ambiguous'; others: string[] }
    | { type: 'unreadable'; failure: CoverageFailure }
    /** A note or canvas could not be read but the check did not say which (should not happen) */
    | { type: 'unreadable-unknown'; canvas: boolean }
    | { type: 'changed' }
    | { type: 'missing' }
    | { type: 'protected' };

export interface KeptEntry {
    item: KeptItem;
    actions: KeptAction[];
}

export interface KeptCard {
    path: string;
    name: string;
    sizeBytes: number;
    entries: KeptEntry[];
    /** Actions for the file as a whole (remove the links and delete, scan again) */
    fileActions: KeptAction[];
    /** Things to say about the file as a whole */
    notes: Array<'links-not-removable'>;
}

export interface KeptContext {
    protectedFolders: readonly string[];
    /** `on`: removal allowed. `off`: Find embeds is on but removal is switched off (offer to enable). `unavailable`: never offer. */
    linkRemoval: 'on' | 'off' | 'unavailable';
}

const openFor = (ref: BlockerRef): KeptAction =>
    ref.extension === 'canvas' ? { kind: 'open-canvas', path: ref.path } : { kind: 'open-note', path: ref.path };

function assertNever(reason: never): never {
    throw new Error(`Unhandled reason: ${String(reason)}`);
}

export interface DescribeKeptOptions {
    /**
     * Whether every link to the file can be removed automatically (a plan exists for each referring note).
     * False when a link sits in the note properties or a code block, or the index knows a link the text does not
     * show. Absent means "not checked": the action is offered and the click re-checks.
     */
    linksRemovable?: boolean;
}

export function describeKept(
    file: { path: string; name: string; sizeBytes: number },
    eligibility: Eligibility,
    ctx: KeptContext,
    opts: DescribeKeptOptions = {},
): KeptCard {
    const entries: KeptEntry[] = [];
    const fileActions: KeptAction[] = [];
    const notes: KeptCard['notes'] = [];
    const blockers = eligibility.blockers;
    const referrers = blockers?.referrers ?? [];
    const addFileAction = (action: KeptAction): void => {
        if (!fileActions.some((a) => a.kind === action.kind)) fileActions.push(action);
    };

    for (const reason of eligibility.reasons) {
        switch (reason) {
            case 'still-referenced': {
                if (referrers.length === 0) {
                    entries.push({ item: { type: 'referenced-unknown', count: eligibility.referenceCount }, actions: [] });
                    break;
                }
                for (const ref of referrers) {
                    entries.push({
                        item: { type: 'referenced', ref, protectedReferrer: isProtectedPath(ctx.protectedFolders, ref.path) },
                        actions: [openFor(ref)],
                    });
                }
                break;
            }
            case 'ambiguous-reference': {
                const others = blockers?.sameNameFiles ?? [];
                entries.push({ item: { type: 'ambiguous', others }, actions: others.map((path) => ({ kind: 'open-file' as const, path })) });
                break;
            }
            case 'canvas-unreadable':
            case 'scan-incomplete': {
                const kind = reason === 'canvas-unreadable' ? 'canvas-unreadable' : 'markdown-unreadable';
                const failures = (blockers?.unreadable ?? []).filter((f) => f.kind === kind);
                if (failures.length === 0) entries.push({ item: { type: 'unreadable-unknown', canvas: kind === 'canvas-unreadable' }, actions: [] });
                for (const failure of failures) {
                    entries.push({
                        item: { type: 'unreadable', failure },
                        actions: [failure.kind === 'canvas-unreadable' ? { kind: 'open-canvas', path: failure.path } : { kind: 'open-note', path: failure.path }],
                    });
                }
                break;
            }
            case 'file-changed':
                entries.push({ item: { type: 'changed' }, actions: [] });
                addFileAction({ kind: 'scan-again' });
                break;
            case 'target-missing':
                entries.push({ item: { type: 'missing' }, actions: [] });
                break;
            case 'protected-path':
                entries.push({ item: { type: 'protected' }, actions: [] });
                break;
            default:
                return assertNever(reason);
        }
    }

    // Removing the links is offered only when it alone would make the file deletable: the only thing in the
    // way is plain references from notes that may be edited. Anything else (a canvas, a protected note, an
    // ambiguous name, an unreadable referrer) still blocks after the links are gone.
    const onlyReferenced = eligibility.reasons.length === 1 && eligibility.reasons[0] === 'still-referenced';
    const removable =
        onlyReferenced &&
        referrers.length > 0 &&
        referrers.every((r) => r.extension === 'md' && !isProtectedPath(ctx.protectedFolders, r.path));
    // Offer only what can succeed: when a link cannot be edited automatically, say so instead of offering the button.
    const offerable = removable && opts.linksRemovable !== false;
    if (removable && opts.linksRemovable === false && ctx.linkRemoval !== 'unavailable') notes.push('links-not-removable');
    if (offerable && ctx.linkRemoval === 'on') addFileAction({ kind: 'remove-link-and-delete' });
    if (offerable && ctx.linkRemoval === 'off') addFileAction({ kind: 'enable-link-removal' });

    return { path: file.path, name: file.name, sizeBytes: file.sizeBytes, entries, fileActions, notes };
}
