/**
 * Item identity for the inbox sweep: which items were already added to the sweep report from a note.
 * Pure functions over plain data (the plugin keeps the result in its own data file, never in a note).
 * See docs/features/inbox-sweep.md ("The same item is never added twice").
 */
import { remap, type ApprovalRecord, type ApprovedTask } from './sweepLedger';

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
    const written = text.slice(0, MAX_KEY_CHARS).normalize('NFKC').toLowerCase();
    const words = written.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    // A title with no letters or digits (an emoji, a symbol) still has an identity: the symbols themselves.
    // (Never the key separator: a key is `<quote>|<wording>` and is split at its first `|`.)
    return words !== '' ? words : written.replace(/[\s|]+/g, ' ').trim();
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
