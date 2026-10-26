/**
 * The hand-back journal: one record per hand-back (identified by its content), with its items frozen the first time the review
 * opens. An item is `pending | applying | applied | declined | failed`; intent (`applying`) is saved before every write and each
 * write is idempotent at its own boundary, so a crash resumes by checking receipts, never by repeating an applied item. Pure.
 */
import { isAioId } from '../projects/projectIndex';

export type ItemState = 'pending' | 'applying' | 'applied' | 'declined' | 'failed';
const STATES: readonly ItemState[] = ['pending', 'applying', 'applied', 'declined', 'failed'];

export interface JournalItem {
    section: 'decisions' | 'actions' | 'deliverables' | 'questions';
    state: ItemState;
    /** Why a failed item failed (a guidance code) */
    error?: string;
}

export interface HandbackRecord {
    version: 1;
    id: string;
    /** Where the hand-back note was when the review opened (informational: the id is the identity) */
    notePath: string;
    projectId?: string;
    createdAt: string;
    items: Record<string, JournalItem>;
}

export const MAX_HANDBACK_RECORDS = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const SECTIONS = ['decisions', 'actions', 'deliverables', 'questions'] as const;

export function normaliseHandbacks(raw: unknown): Record<string, HandbackRecord> {
    const out: Record<string, HandbackRecord> = {};
    if (!isRecord(raw)) return out;
    for (const value of Object.values(raw)) {
        if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || typeof value.notePath !== 'string') continue;
        const items: Record<string, JournalItem> = {};
        if (isRecord(value.items)) {
            for (const [id, it] of Object.entries(value.items)) {
                if (!isRecord(it) || !SECTIONS.includes(it.section as never) || !STATES.includes(it.state as ItemState)) continue;
                items[id] = { section: it.section as JournalItem['section'], state: it.state as ItemState, ...(typeof it.error === 'string' ? { error: it.error } : {}) };
            }
        }
        out[value.id] = {
            version: 1,
            id: value.id,
            notePath: value.notePath,
            ...(typeof value.projectId === 'string' && isAioId(value.projectId) ? { projectId: value.projectId.toLowerCase() } : {}),
            createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
            items,
        };
    }
    return out;
}

/** The record for a hand-back, created (frozen) on first sight. Items already in the journal are never replaced by a re-read. */
export function freeze(existing: HandbackRecord | undefined, id: string, notePath: string, now: string, items: ReadonlyArray<{ id: string; section: JournalItem['section'] }>): HandbackRecord {
    const base: HandbackRecord = existing ?? { version: 1, id, notePath, createdAt: now, items: {} };
    const merged = { ...base.items };
    for (const it of items) if (!merged[it.id]) merged[it.id] = { section: it.section, state: 'pending' };
    return { ...base, notePath, items: merged };
}

export function setState(record: HandbackRecord, itemId: string, state: ItemState, error?: string): HandbackRecord {
    const current = record.items[itemId];
    if (!current) return record;
    // An applied item is final: a retry never re-applies it.
    if (current.state === 'applied') return record;
    return { ...record, items: { ...record.items, [itemId]: { section: current.section, state, ...(error ? { error } : {}) } } };
}

export function withProject(record: HandbackRecord, projectId: string): HandbackRecord {
    return { ...record, projectId };
}

/** At start-up: an `applying` item has an unknown outcome, so it goes back to `pending` to be checked against its receipt. */
export function recoverApplying(record: HandbackRecord): HandbackRecord {
    const items: Record<string, JournalItem> = {};
    for (const [id, it] of Object.entries(record.items)) items[id] = it.state === 'applying' ? { section: it.section, state: 'pending' } : it;
    return { ...record, items };
}

/** Keep the newest records; finished ones go first. */
export function prune(records: Record<string, HandbackRecord>): Record<string, HandbackRecord> {
    const all = Object.values(records);
    if (all.length <= MAX_HANDBACK_RECORDS) return records;
    // Never dropped while unresolved: an interrupted (applying) or failed item still needs its receipt checked. A hand-back that is
    // only pending or finished can go: its items are frozen again, from the file, the next time it is opened.
    const open = (r: HandbackRecord): boolean => Object.values(r.items).some((i) => i.state === 'applying' || i.state === 'failed');
    const sorted = [...all].sort((a, b) => Number(open(b)) - Number(open(a)) || b.createdAt.localeCompare(a.createdAt));
    const unresolved = sorted.filter(open);
    const rest = sorted.filter((r) => !open(r)).slice(0, Math.max(0, MAX_HANDBACK_RECORDS - unresolved.length));
    return Object.fromEntries([...unresolved, ...rest].map((r) => [r.id, r]));
}
