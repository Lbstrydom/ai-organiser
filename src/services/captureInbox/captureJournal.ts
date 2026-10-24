/**
 * Pure operations over the capture journal. Every function returns a new journal; the store
 * (Obsidian-facing) persists it. Nothing here reads a file, a clock or settings.
 */
import {
    CaptureCounters,
    CaptureEntry,
    CaptureJournal,
    CaptureState,
    CaptureTombstone,
    MAX_ATTEMPTS,
    MAX_AWAITING_REVIEW,
    emptyJournal,
} from './captureTypes';
import { isHeld, isTerminal } from './captureStateMachine';

/** Tombstones are compact (no text), but they still must not grow without bound. */
export const MAX_TOMBSTONES = 2000;

type TombstoneState = CaptureTombstone['state'];

export function getEntry(journal: CaptureJournal, id: string): CaptureEntry | undefined {
    return journal.entries[resolveId(journal, id)];
}

/** A media path that gained a companion note resolves to the note's id. */
export function resolveId(journal: CaptureJournal, id: string): string {
    return journal.aliases[id] ?? id;
}

export function upsertEntry(journal: CaptureJournal, entry: CaptureEntry): CaptureJournal {
    const { [entry.id]: _dropped, ...rest } = journal.tombstones;
    void _dropped;
    return { ...journal, entries: { ...journal.entries, [entry.id]: entry }, tombstones: rest };
}

export function removeEntry(journal: CaptureJournal, id: string): CaptureJournal {
    const { [id]: _dropped, ...rest } = journal.entries;
    void _dropped;
    return { ...journal, entries: rest };
}

export function addAlias(journal: CaptureJournal, mediaPath: string, notePath: string): CaptureJournal {
    return { ...journal, aliases: { ...journal.aliases, [mediaPath]: notePath } };
}

/** Re-key everything that mentions `oldId` (a vault rename or move). A no-op when unknown. */
export function rekey(journal: CaptureJournal, oldId: string, newId: string): CaptureJournal {
    if (oldId === newId) return journal;
    let next = journal;
    const entry = journal.entries[oldId];
    if (entry) {
        const { [oldId]: _dropped, ...rest } = journal.entries;
        void _dropped;
        next = { ...next, entries: { ...rest, [newId]: { ...entry, id: newId } } };
    }
    const tomb = journal.tombstones[oldId];
    if (tomb) {
        const { [oldId]: _dropped, ...rest } = next.tombstones;
        void _dropped;
        next = { ...next, tombstones: { ...rest, [newId]: { ...tomb, id: newId } } };
    }
    const aliases: Record<string, string> = {};
    let aliasChanged = false;
    for (const [media, note] of Object.entries(next.aliases)) {
        const key = media === oldId ? newId : media;
        const value = note === oldId ? newId : note;
        if (key !== media || value !== note) aliasChanged = true;
        aliases[key] = value;
    }
    return aliasChanged ? { ...next, aliases } : next;
}

/** Entries waiting for the user (review or an Accept write in flight). */
export function awaitingCount(journal: CaptureJournal): number {
    return Object.values(journal.entries).filter((e) => e.state === 'awaiting_review' || e.state === 'accept_pending_write').length;
}

/** Backpressure: stop spending money while the user has a backlog to review. */
export function canStartProcessing(journal: CaptureJournal): boolean {
    return awaitingCount(journal) < MAX_AWAITING_REVIEW;
}

/** Note paths the inbox sweep must not read: everything the capture workflow still holds. */
export function heldPaths(journal: CaptureJournal): string[] {
    return Object.values(journal.entries).filter((e) => isHeld(e.state)).map((e) => e.id);
}

/**
 * Convert a finished capture to a tombstone (no text). `accepted` and `organised` ignore later
 * edits; `skipped` and `skipped_by_user` are re-offered only when the fingerprint changes.
 */
export function finish(journal: CaptureJournal, id: string, state: TombstoneState, now: number, policyRevision?: string): CaptureJournal {
    const entry = journal.entries[id];
    const fingerprintHash = entry?.fingerprint ?? journal.tombstones[id]?.fingerprintHash ?? '';
    const { [id]: _dropped, ...rest } = journal.entries;
    void _dropped;
    const tombstones = pruneTombstones({ ...journal.tombstones, [id]: { id, fingerprintHash, state, at: now, ...(policyRevision ? { policyRevision } : {}) } });
    return { ...journal, entries: rest, tombstones };
}

function pruneTombstones(tombstones: Record<string, CaptureTombstone>): Record<string, CaptureTombstone> {
    const all = Object.values(tombstones);
    if (all.length <= MAX_TOMBSTONES) return tombstones;
    // Skipped records go first: an accepted or organised one must outlive them, or that capture could be processed again.
    const rank = (t: CaptureTombstone): number => (t.state === 'accepted' || t.state === 'organised' ? 1 : 0);
    const keep = all.sort((a, b) => rank(b) - rank(a) || b.at - a.at).slice(0, MAX_TOMBSTONES);
    return Object.fromEntries(keep.map((t) => [t.id, t]));
}

/**
 * Has this capture (at this fingerprint) already been dealt with? A finished-and-accepted capture is
 * never re-processed whatever happens to the text; a skipped one is re-offered when it changed.
 */
export function alreadyHandled(journal: CaptureJournal, id: string, fingerprint: string, policyRevision?: string): boolean {
    const tomb = journal.tombstones[resolveId(journal, id)];
    if (tomb) {
        if (tomb.state === 'accepted' || tomb.state === 'organised') return true;
        // A capture skipped under an older exclusion policy is re-offered when the policy changed.
        if (tomb.state === 'skipped' && tomb.policyRevision && policyRevision && tomb.policyRevision !== policyRevision) return false;
        return tomb.fingerprintHash === fingerprint;
    }
    return false;
}

/** Accepted and organised captures keep their text only while recent; older ones become tombstones. */
export const KEEP_FINISHED = 25;

export function pruneFinished(journal: CaptureJournal, now: number, keep = KEEP_FINISHED): CaptureJournal {
    const done = Object.values(journal.entries)
        .filter((e) => e.state === 'accepted' || e.state === 'organised')
        .sort((a, b) => b.updatedAt - a.updatedAt);
    let next = journal;
    for (const e of done.slice(keep)) next = finish(next, e.id, e.state === 'organised' ? 'organised' : 'accepted', now);
    return next;
}

export type CounterKey = 'processed' | 'acceptedUnchanged' | 'acceptedEdited' | 'rejected';

export function bump(journal: CaptureJournal, key: CounterKey): CaptureJournal {
    return { ...journal, counters: { ...journal.counters, [key]: journal.counters[key] + 1 } };
}

export function bumpBucket(journal: CaptureJournal, bucket: 'failed' | 'skipped', name: string): CaptureJournal {
    const current: CaptureCounters = journal.counters;
    return { ...journal, counters: { ...current, [bucket]: { ...current[bucket], [name]: (current[bucket][name] ?? 0) + 1 } } };
}

export interface ReconcileResult {
    journal: CaptureJournal;
    /** Capture ids whose Accept write must be retried (and only those: reconcile writes nothing else) */
    retryWrites: string[];
}

/**
 * Startup recovery. `blockPresent(id)` answers whether the capture note already carries a matching
 * plugin block (the caller reads the note; `undefined` = could not tell).
 *
 *  - `accept_pending_write` with the block present -> accepted; absent -> retry the write only;
 *  - `processing` -> failed at the recorded stage, attempts + 1 (a paid call can repeat at most once per attempt);
 *  - `awaiting_review` is never written on startup.
 */
export function reconcile(journal: CaptureJournal, blockPresent: (id: string) => boolean | undefined, now: number): ReconcileResult {
    let next = journal;
    const retryWrites: string[] = [];
    for (const entry of Object.values(journal.entries)) {
        if (entry.state === 'accept_pending_write') {
            const present = blockPresent(entry.id);
            if (present === true) next = finish(next, entry.id, 'accepted', now);
            else if (present === false) retryWrites.push(entry.id);
            continue;
        }
        if (entry.state === 'processing') {
            const attempts = entry.attempts + 1;
            next = upsertEntry(next, {
                ...entry,
                state: 'failed',
                failedStage: entry.stage ?? 'read',
                attempts,
                retriable: attempts < MAX_ATTEMPTS,
                updatedAt: now,
            });
        }
    }
    return { journal: next, retryWrites };
}

/** Normalise unknown persisted data into a journal (fail closed to an empty one). */
export function coerceJournal(raw: unknown): CaptureJournal {
    if (!raw || typeof raw !== 'object') return emptyJournal();
    const r = raw as Partial<CaptureJournal>;
    if (r.version !== 1 || typeof r.entries !== 'object' || r.entries === null) return emptyJournal();
    const base = emptyJournal();
    return {
        version: 1,
        entries: r.entries,
        tombstones: r.tombstones ?? {},
        aliases: r.aliases ?? {},
        counters: { ...base.counters, ...(r.counters ?? {}) },
    };
}

export function entriesInState(journal: CaptureJournal, ...states: CaptureState[]): CaptureEntry[] {
    return Object.values(journal.entries).filter((e) => states.includes(e.state));
}

export function countTerminal(journal: CaptureJournal): number {
    return Object.values(journal.entries).filter((e) => isTerminal(e.state)).length;
}
