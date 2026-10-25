/**
 * Sweep ledger and the durable approval record (the outbox). Pure functions over plain data that
 * the plugin stores in its own data file, never in a note.
 *
 * The ledger says which notes were swept and at what content hash, so a note is offered again only
 * when it changed. The approval record is written at "Add to sweep report" BEFORE anything else
 * happens, because edited proposals cannot be regenerated:
 *   1. persist the record (tasks and source dispositions);
 *   2. commit the report section (skipped when there are zero approved tasks);
 *   3. mark items `reported`, and mark the sources whose disposition says so as swept;
 *   4. export only `reported` items.
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';

export interface LedgerEntry {
    sha256: string;
    sweptAt: string;
    runId: string;
}

export type SweepLedger = Record<string, LedgerEntry>;

export type TaskState = 'approved' | 'reported' | 'exported' | 'failed';

export interface ApprovedTask {
    id: string;
    text: string;
    context: string;
    sourcePath: string;
    sourceHash: string;
    state: TaskState;
    /** Stable code when the last export attempt failed */
    error?: string;
    /** Item identity (see `itemKeys`); absent on tasks approved before item identity existed */
    keys?: string[];
}

// ─── Item identity ──────────────────────────────────────────────────────────
// The ledger above is per NOTE. When a note changes it is read again and every item in it is proposed
// again, so the items already approved from it must be recognisable: otherwise ticking them writes the
// same task into the report and the export a second time.

/** Source path -> the identity keys of the items already reported from it. */
export type ReportedItems = Record<string, string[]>;

/** Keys kept per note. Each approved item adds one or two, so this holds several hundred items. */
export const MAX_REPORTED_KEYS_PER_NOTE = 500;
const MAX_KEY_CHARS = 400;
/** Matches the longest text (300) and quote (400) the sweep accepts, so long items never collapse onto a shared prefix. */
const KEY_SEPARATOR = '|';

/** Letters and digits only, lower case, single spaces: stable across punctuation, case and spacing edits. */
export function normaliseItemText(text: string): string {
    // The cap is on the text as written (the report cuts a task at 300 characters of it), BEFORE normalising:
    // normalising can lengthen text (NFKC expands ligatures), and cutting after it would merge distinct items.
    return text.slice(0, MAX_KEY_CHARS).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The identity of one proposed item, as `<quote>|<wording>` pairs (normalised): one for the model's wording
 * and one for the user's edited wording. The quote alone never identifies an item (a sentence can hold two
 * commitments); see `isReportedItem`.
 */
export function itemKeys(parts: { text: string; evidence: string; edited?: string }): string[] {
    const quote = normaliseItemText(parts.evidence);
    const wordings = [parts.text, ...(parts.edited !== undefined ? [parts.edited] : [])].map(normaliseItemText).filter(Boolean);
    return [...new Set(wordings.map((w) => `${quote}${KEY_SEPARATOR}${w}`))];
}

const KIND_PREFIX = /^(?:waiting|project|someday):\s*/i;

/**
 * Keys for a task recorded before keys existed: its stored text (no quote is known) without the kind prefix.
 * The review appended " (who)" only to waiting-for items, so only for those is a trailing parenthesis also
 * tried off; a parenthesis the user wrote in another task stays part of its wording.
 */
export function legacyTaskKeys(text: string): string[] {
    const waiting = /^waiting:\s*/i.test(text);
    const body = text.replace(KIND_PREFIX, '');
    const wordings = [body, ...(waiting ? [body.replace(/\s*\([^()]*\)\s*$/, '')] : [])].map(normaliseItemText);
    return [...new Set(wordings.filter(Boolean).map((w) => `${KEY_SEPARATOR}${w}`))];
}

const keysOfTask = (t: ApprovedTask): string[] => (t.keys && t.keys.length > 0 ? t.keys : legacyTaskKeys(t.text));

/**
 * Everything known to have been reported from one note: the stored keys plus whatever the approval records
 * still hold. A task whose EXPORT failed is still in the report, so it counts.
 */
export function reportedKeysFor(path: string, stored: ReportedItems, records: readonly ApprovalRecord[]): Set<string> {
    const known = new Set<string>(stored[path] ?? []);
    for (const record of records) {
        for (const task of record.tasks) {
            if (task.sourcePath !== path) continue;
            for (const key of keysOfTask(task)) known.add(key);
        }
    }
    return known;
}

function splitKey(key: string): [string, string] {
    const at = key.indexOf(KEY_SEPARATOR);
    return at === -1 ? ['', key] : [key.slice(0, at), key.slice(at + 1)];
}

/** Word overlap (Jaccard) of two normalised texts. */
function overlap(a: string, b: string): number {
    const left = new Set(a.split(' ').filter(Boolean));
    const right = new Set(b.split(' ').filter(Boolean));
    if (left.size === 0 || right.size === 0) return 0;
    let both = 0;
    for (const w of left) if (right.has(w)) both++;
    return both / (left.size + right.size - both);
}

/** Same quoted line and at least this much shared wording: probably the model's rewording of an item already added. */
const SAME_QUOTE_MIN_OVERLAP = 0.5;

/**
 * How does a proposed item relate to what was reported from its note?
 *  - `exact`: the same wording. It is the same item, and it is never added twice.
 *  - `similar`: the same quoted line with similar but different wording. Probably the model's rewording,
 *    possibly a second commitment in one sentence ("Send the invoice to Alice and to Bob"), so the user
 *    is told and decides.
 *  - null: not seen before.
 */
export function reportedMatch(known: ReadonlySet<string>, keys: readonly string[]): 'exact' | 'similar' | null {
    if (known.size === 0 || keys.length === 0) return null;
    const pairs = [...known].map(splitKey);
    let similar = false;
    for (const key of keys) {
        const [quote, wording] = splitKey(key);
        for (const [knownQuote, knownWording] of pairs) {
            if (wording !== '' && knownWording === wording) return 'exact';
            if (quote !== '' && knownQuote === quote && overlap(wording, knownWording) >= SAME_QUOTE_MIN_OVERLAP) similar = true;
        }
    }
    return similar ? 'similar' : null;
}

/** True when the same wording was reported before (the only match that is enforced). */
export function isReportedItem(known: ReadonlySet<string>, keys: readonly string[]): boolean {
    return reportedMatch(known, keys) === 'exact';
}

/** Step 3b companion: remember the items of a record whose report section is written. Pure. */
export function recordReportedItems(stored: ReportedItems, record: ApprovalRecord): ReportedItems {
    const next: ReportedItems = { ...stored };
    for (const task of record.tasks) {
        const merged = [...new Set([...(next[task.sourcePath] ?? []), ...keysOfTask(task)])];
        next[task.sourcePath] = merged.slice(-MAX_REPORTED_KEYS_PER_NOTE);
    }
    return next;
}

/**
 * Drop tasks that were already reported from their note, or repeat inside this batch. A task without keys is
 * judged by its text, so the guarantee holds for any caller, not only the review modal.
 */
export function dropAlreadyReported<T extends { sourcePath: string; text: string; keys?: string[] }>(
    tasks: readonly T[],
    stored: ReportedItems,
    records: readonly ApprovalRecord[],
): { kept: T[]; dropped: number } {
    const knownByPath = new Map<string, Set<string>>();
    const kept: T[] = [];
    for (const task of tasks) {
        const keys = task.keys && task.keys.length > 0 ? task.keys : legacyTaskKeys(task.text);
        let known = knownByPath.get(task.sourcePath);
        if (!known) {
            known = reportedKeysFor(task.sourcePath, stored, records);
            knownByPath.set(task.sourcePath, known);
        }
        if (isReportedItem(known, keys)) continue;
        // Only what will be reported counts for the rest of the batch: a dropped task adds nothing to the state.
        for (const key of keys) known.add(key);
        kept.push(task);
    }
    return { kept, dropped: tasks.length - kept.length };
}

export interface Disposition {
    sourcePath: string;
    sourceHash: string;
    markSwept: boolean;
}

export interface ApprovalRecord {
    runId: string;
    createdAt: string;
    reportPath: string;
    listId?: string;
    tasks: ApprovedTask[];
    dispositions: Disposition[];
    /** The report section is known to be in the note (or there was nothing to write) */
    reportDone: boolean;
    /** The dispositions were applied to the ledger */
    ledgerDone: boolean;
}

export function isSwept(ledger: SweepLedger, path: string, hash: string): boolean {
    return ledger[path]?.sha256 === hash;
}

export function newApproval(input: {
    runId: string;
    now: string;
    reportPath: string;
    listId?: string;
    tasks: ReadonlyArray<Omit<ApprovedTask, 'state'>>;
    dispositions: readonly Disposition[];
}): ApprovalRecord {
    return {
        runId: input.runId,
        createdAt: input.now,
        reportPath: input.reportPath,
        listId: input.listId,
        tasks: input.tasks.map((t) => ({ ...t, state: 'approved' as const })),
        dispositions: [...input.dispositions],
        reportDone: input.tasks.length === 0,
        ledgerDone: false,
    };
}

/** Step 3a: the report section is in the note, so approved items become reported. */
export function markReported(record: ApprovalRecord): ApprovalRecord {
    return {
        ...record,
        reportDone: true,
        tasks: record.tasks.map((t) => (t.state === 'approved' ? { ...t, state: 'reported' as const } : t)),
    };
}

/** Step 3b: apply the dispositions to the ledger. Pure: returns the new ledger. */
export function applyDispositions(ledger: SweepLedger, record: ApprovalRecord, now: string): SweepLedger {
    const next: SweepLedger = { ...ledger };
    for (const d of record.dispositions) {
        if (d.markSwept) next[d.sourcePath] = { sha256: d.sourceHash, sweptAt: now, runId: record.runId };
    }
    return next;
}

/** Items that may be sent to Google Tasks: reported and not yet exported. */
export function exportable(record: ApprovalRecord): ApprovedTask[] {
    return record.tasks.filter((t) => t.state === 'reported' || (t.state === 'failed' && t.error !== 'conflict'));
}

export interface ExportResult {
    exportId: string;
    status: 'created' | 'exists' | 'error' | 'retry' | 'conflict';
}

/** Fold the script's per-item answers into the record. `retry` leaves the item as it was. */
export function applyExportResults(record: ApprovalRecord, results: readonly ExportResult[]): ApprovalRecord {
    const by = new Map(results.map((r) => [r.exportId, r.status]));
    return {
        ...record,
        tasks: record.tasks.map((t) => {
            const status = by.get(t.id);
            if (!status || status === 'retry') return t;
            if (status === 'created' || status === 'exists') return { ...t, state: 'exported' as const, error: undefined };
            return { ...t, state: 'failed' as const, error: status === 'conflict' ? 'conflict' : 'export-failed' };
        }),
    };
}

/** True when nothing is left to do for this record. */
export function isComplete(record: ApprovalRecord): boolean {
    return record.reportDone && record.ledgerDone && record.tasks.every((t) => t.state === 'exported' || (t.state === 'failed' && t.error === 'conflict'));
}

/** Records that still have work: an unfinished report or ledger step, or tasks waiting to be exported. */
export function pendingApprovals(records: readonly ApprovalRecord[], exportEnabled: boolean): ApprovalRecord[] {
    return records.filter((r) => !r.reportDone || !r.ledgerDone || (exportEnabled && exportable(r).length > 0));
}

/** Keep the most recent finished records only; unfinished ones are never dropped. */
export function pruneApprovals(records: readonly ApprovalRecord[], keepFinished = 20): ApprovalRecord[] {
    const open = records.filter((r) => !isComplete(r));
    const done = records.filter(isComplete).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, keepFinished);
    return [...open, ...done];
}

// ─── Renames ────────────────────────────────────────────────────────────────

function remap(path: string, oldPath: string, newPath: string): string {
    const p = normalisePath(path);
    const o = normalisePath(oldPath);
    if (p === o) return normalisePath(newPath);
    if (isInsideOrEqual(p, o)) return normalisePath(newPath) + p.slice(o.length);
    return path;
}

/** A file or folder was renamed: move the ledger keys with it. */
export function renameLedger(ledger: SweepLedger, oldPath: string, newPath: string): { ledger: SweepLedger; changed: boolean } {
    const out: SweepLedger = {};
    let changed = false;
    for (const [key, entry] of Object.entries(ledger)) {
        const next = remap(key, oldPath, newPath);
        if (next !== key) changed = true;
        out[next] = entry;
    }
    return { ledger: out, changed };
}

/** The same remap for the reported-item keys. */
export function renameReportedItems(items: ReportedItems, oldPath: string, newPath: string): { items: ReportedItems; changed: boolean } {
    const out: ReportedItems = {};
    let changed = false;
    for (const [key, keys] of Object.entries(items)) {
        const next = remap(key, oldPath, newPath);
        if (next !== key) changed = true;
        out[next] = [...new Set([...(out[next] ?? []), ...keys])].slice(-MAX_REPORTED_KEYS_PER_NOTE);
    }
    return { items: out, changed };
}

/** The same remap for the source paths inside open approval records. */
export function renameApprovals(records: readonly ApprovalRecord[], oldPath: string, newPath: string): { records: ApprovalRecord[]; changed: boolean } {
    let changed = false;
    const out = records.map((r) => {
        const tasks = r.tasks.map((t) => {
            const next = remap(t.sourcePath, oldPath, newPath);
            if (next !== t.sourcePath) changed = true;
            return next === t.sourcePath ? t : { ...t, sourcePath: next };
        });
        const dispositions = r.dispositions.map((d) => {
            const next = remap(d.sourcePath, oldPath, newPath);
            if (next !== d.sourcePath) changed = true;
            return next === d.sourcePath ? d : { ...d, sourcePath: next };
        });
        const reportPath = remap(r.reportPath, oldPath, newPath);
        if (reportPath !== r.reportPath) changed = true;
        return { ...r, tasks, dispositions, reportPath };
    });
    return { records: out, changed };
}
