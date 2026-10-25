/**
 * Which captures a manual run would really send, so the confirmation can state it truthfully. Pure.
 *
 * A run handles only captures that are settled (state `ready`), oldest first, at most `cap` of them. A capture
 * that has no journal entry yet is one the "Also process existing notes" box would add: it is old by definition
 * and needs no settling, so it counts as ready. Captures that are still settling are not sent by this run.
 */
import type { ScannedCapture } from './captureScanner';
import type { CaptureState } from './captureTypes';

export interface RunSelection {
    /** The captures this run sends, in the order it handles them */
    sent: ScannedCapture[];
    /** Ready captures that do not fit in this run and wait for the next one */
    later: number;
}

export function selectForRun(captures: readonly ScannedCapture[], stateOf: (id: string) => CaptureState | undefined, cap: number): RunSelection {
    const sendable = captures
        .filter((c) => {
            const state = stateOf(c.id);
            return state === undefined || state === 'ready';
        })
        .sort((a, b) => a.ctime - b.ctime);
    // A limit that is not a finite number sends nothing: fail closed rather than send everything.
    const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
    return { sent: sendable.slice(0, limit), later: Math.max(0, sendable.length - limit) };
}
