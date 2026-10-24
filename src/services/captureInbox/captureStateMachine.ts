/**
 * The per-capture state machine as data. An unknown transition is refused (fail closed), so a
 * caller bug cannot move a capture into a state the rest of the feature does not expect.
 */
import type { CaptureEntry, CaptureState } from './captureTypes';

const TRANSITIONS: Readonly<Record<CaptureState, readonly CaptureState[]>> = {
    new: ['waiting_for_stable', 'skipped'],
    waiting_for_stable: ['waiting_for_stable', 'ready', 'skipped'],
    ready: ['processing', 'waiting_for_stable', 'skipped'],
    processing: ['processing', 'awaiting_review', 'failed', 'skipped'],
    failed: ['ready', 'waiting_for_stable', 'skipped_by_user'],
    awaiting_review: ['waiting_for_stable', 'skipped_by_user', 'accept_pending_write'],
    accept_pending_write: ['accepted', 'awaiting_review'],
    accepted: ['organised'],
    organised: [],
    skipped: [],
    skipped_by_user: [],
};

/** States that end a capture's life in the queue (a tombstone may remain). */
const TERMINAL: ReadonlySet<CaptureState> = new Set(['accepted', 'organised', 'skipped', 'skipped_by_user']);

export function canTransition(from: CaptureState, to: CaptureState): boolean {
    return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Terminal for the queue. `accepted` can still become `organised`, but nothing waits on it. */
export function isTerminal(state: CaptureState): boolean {
    return TERMINAL.has(state);
}

/**
 * Held by the capture workflow: the note has not been accepted yet, so the inbox sweep must not
 * read it (it would sweep a raw note and then see its hash change).
 */
export function isHeld(state: CaptureState): boolean {
    return !TERMINAL.has(state);
}

/** A state the processor may pick up on its own. */
export function isRunnable(state: CaptureState): boolean {
    return state === 'ready';
}

/** Move an entry. Returns the entry unchanged and `ok: false` when the transition is not allowed. */
export function transition(
    entry: CaptureEntry,
    to: CaptureState,
    now: number,
    patch: Partial<CaptureEntry> = {},
): { ok: boolean; entry: CaptureEntry } {
    if (!canTransition(entry.state, to)) return { ok: false, entry };
    return { ok: true, entry: { ...entry, ...patch, state: to, updatedAt: now } };
}
