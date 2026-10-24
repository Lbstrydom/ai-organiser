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

/**
 * Re-key everything at or under `oldPath` after a rename or a folder move. Every id that is `oldPath` or
 * inside it follows to the new location; a no-op when nothing matches.
 */
export function rekeyTree(journal: CaptureJournal, oldPath: string, newPath: string): CaptureJournal {
    const prefix = oldPath.replace(/\/+$/, '');
    const move = (id: string): string | null => (id === prefix ? newPath : id.startsWith(prefix + '/') ? newPath + id.slice(prefix.length) : null);
    let next = journal;
    const ids = new Set([...Object.keys(journal.entries), ...Object.keys(journal.tombstones), ...Object.keys(journal.aliases), ...Object.values(journal.aliases)]);
    for (const id of ids) {
        const to = move(id);
        if (to !== null && to !== id) next = rekey(next, id, to);
    }
    return next;
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
    // Only skipped records are capped (oldest first). An accepted or organised tombstone is the evidence that a capture is
    // done: dropping it would let the capture be processed, and charged, again. They are a few dozen bytes each.
    const finished = Object.values(tombstones).filter((t) => t.state === 'accepted' || t.state === 'organised');
    const skipped = Object.values(tombstones).filter((t) => t.state !== 'accepted' && t.state !== 'organised');
    if (skipped.length <= MAX_TOMBSTONES) return tombstones;
    const keep = [...finished, ...skipped.sort((a, b) => b.at - a.at).slice(0, MAX_TOMBSTONES)];
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
            if (present === true) next = upsertEntry(next, { ...entry, state: 'accepted', updatedAt: now });
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

export type JournalDecode =
    | { status: 'empty'; journal: CaptureJournal }
    | { status: 'ok'; journal: CaptureJournal }
    | { status: 'corrupt'; reason: string };

const ENTRY_STATES = new Set<string>(['new', 'waiting_for_stable', 'ready', 'processing', 'awaiting_review', 'accept_pending_write', 'accepted', 'organised', 'failed', 'skipped', 'skipped_by_user']);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the persisted journal. FAILS CLOSED: nothing stored is a fresh start, but anything stored that cannot be fully
 * understood is `corrupt`, never silently turned into an empty journal. An empty journal forgets which captures were
 * handled, so every one would be processed (and charged) again, and it would lose held captures and pending writes.
 */
export function decodeJournal(raw: unknown): JournalDecode {
    if (raw === undefined || raw === null) return { status: 'empty', journal: emptyJournal() };
    if (!isRecord(raw)) return { status: 'corrupt', reason: 'not an object' };
    if (raw.version !== 1) return { status: 'corrupt', reason: 'unsupported version' };
    if (!isRecord(raw.entries)) return { status: 'corrupt', reason: 'entries missing' };
    const entries: Record<string, CaptureEntry> = {};
    for (const [key, value] of Object.entries(raw.entries)) {
        if (!isRecord(value) || typeof value.id !== 'string' || typeof value.state !== 'string' || !ENTRY_STATES.has(value.state)) {
            return { status: 'corrupt', reason: `entry ${key} is malformed` };
        }
        entries[key] = value as unknown as CaptureEntry;
    }
    const tombstones: Record<string, CaptureTombstone> = {};
    if (raw.tombstones !== undefined) {
        if (!isRecord(raw.tombstones)) return { status: 'corrupt', reason: 'tombstones malformed' };
        for (const [key, value] of Object.entries(raw.tombstones)) {
            if (!isRecord(value) || typeof value.id !== 'string' || typeof value.fingerprintHash !== 'string') return { status: 'corrupt', reason: `tombstone ${key} is malformed` };
            tombstones[key] = value as unknown as CaptureTombstone;
        }
    }
    const aliases: Record<string, string> = {};
    if (raw.aliases !== undefined) {
        if (!isRecord(raw.aliases)) return { status: 'corrupt', reason: 'aliases malformed' };
        for (const [key, value] of Object.entries(raw.aliases)) {
            if (typeof value !== 'string') return { status: 'corrupt', reason: `alias ${key} is malformed` };
            aliases[key] = value;
        }
    }
    const base = emptyJournal().counters;
    const c = raw.counters;
    if (c !== undefined && !isRecord(c)) return { status: 'corrupt', reason: 'counters malformed' };
    const num = (v: unknown, fallback: number): number | null => (v === undefined ? fallback : typeof v === 'number' && Number.isFinite(v) ? v : null);
    const counts = (v: unknown): Record<string, number> | null => {
        if (v === undefined) return {};
        if (!isRecord(v)) return null;
        const out: Record<string, number> = {};
        for (const [k, n] of Object.entries(v)) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return null;
            out[k] = n;
        }
        return out;
    };
    const cc = (c ?? {});
    const processed = num(cc.processed, base.processed);
    const acceptedUnchanged = num(cc.acceptedUnchanged, base.acceptedUnchanged);
    const acceptedEdited = num(cc.acceptedEdited, base.acceptedEdited);
    const rejected = num(cc.rejected, base.rejected);
    const failed = counts(cc.failed);
    const skipped = counts(cc.skipped);
    if (processed === null || acceptedUnchanged === null || acceptedEdited === null || rejected === null || failed === null || skipped === null) {
        return { status: 'corrupt', reason: 'counters malformed' };
    }
    return { status: 'ok', journal: { version: 1, entries, tombstones, aliases, counters: { processed, acceptedUnchanged, acceptedEdited, rejected, failed, skipped } } };
}

export function entriesInState(journal: CaptureJournal, ...states: CaptureState[]): CaptureEntry[] {
    return Object.values(journal.entries).filter((e) => states.includes(e.state));
}

export function countTerminal(journal: CaptureJournal): number {
    return Object.values(journal.entries).filter((e) => isTerminal(e.state)).length;
}
