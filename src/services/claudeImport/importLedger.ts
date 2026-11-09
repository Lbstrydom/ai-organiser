/**
 * The import record of the Claude importer: what was observed in the source folder and what was copied into the vault.
 * Pure: types, an empty record and a strict decoder. Stored under the data-only key `claude-import-ledger`.
 *
 * Everything here was OBSERVED by the plugin (a file name, its size and modified time, a sha256 of its bytes, when it was
 * copied and to where). Nothing a file says about itself is recorded.
 */

/** Why a file was not imported. Each is also a guidance code `claude-import-<reason>`. */
export const REFUSAL_REASONS = [
    'too-large',
    'not-text',
    'frontmatter-unreadable',
    'reserved-property',
    'reserved-marker',
    'active-content',
    'unsupported-name',
    'name-taken',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Saved just before a copy is created: an intent, not proof of creation. */
export interface PendingEntry {
    /** The source file name */
    name: string;
    /** The vault path chosen for the copy */
    path: string;
    at: string;
    /** The path exists with other bytes: the person decides (never resolved automatically) */
    ambiguous?: boolean;
}

export interface ImportedEntry {
    name: string;
    path: string;
    at: string;
    /** The copy read back with the same sha256 */
    verified: boolean;
}

/** The last observation of a source file, by name. */
export interface SeenEntry {
    /** File identity "dev:ino" */
    fid: string;
    size: number;
    mtimeMs: number;
    /** When this exact (fid, size, mtime) was first observed (ms) */
    at: number;
    /** sha256 of the bytes read while (fid, size, mtime) were these */
    hash?: string;
    hashedAt?: number;
    /** The last read attempt of this name, whatever its outcome (ms): the fair scheduler's key */
    attemptedAt?: number;
}

export interface RefusedEntry {
    fid: string;
    size: number;
    mtimeMs: number;
    reason: RefusalReason;
    /** The size limit the file was judged by: a changed limit judges it again */
    maxKB: number;
}

export interface ImportLedger {
    v: 1;
    pending: Record<string, PendingEntry>;
    imported: Record<string, ImportedEntry>;
    seen: Record<string, SeenEntry>;
    refused: Record<string, RefusedEntry>;
}

export const emptyLedger = (): ImportLedger => ({ v: 1, pending: {}, imported: {}, seen: {}, refused: {} });

export type DecodedLedger = { status: 'ok'; ledger: ImportLedger } | { status: 'corrupt'; reason: string };

const SHA = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optNum = (v: unknown): boolean => v === undefined || isNum(v);

function pending(v: unknown): PendingEntry | null {
    if (!isObj(v) || !isStr(v.name) || !isStr(v.path) || !isStr(v.at)) return null;
    if (v.ambiguous !== undefined && typeof v.ambiguous !== 'boolean') return null;
    return { name: v.name, path: v.path, at: v.at, ...(v.ambiguous === true ? { ambiguous: true } : {}) };
}

function imported(v: unknown): ImportedEntry | null {
    if (!isObj(v) || !isStr(v.name) || !isStr(v.path) || !isStr(v.at) || typeof v.verified !== 'boolean') return null;
    return { name: v.name, path: v.path, at: v.at, verified: v.verified };
}

function seen(v: unknown): SeenEntry | null {
    if (!isObj(v) || !isStr(v.fid) || !isNum(v.size) || !isNum(v.mtimeMs) || !isNum(v.at)) return null;
    if (v.hash !== undefined && !(typeof v.hash === 'string' && SHA.test(v.hash))) return null;
    if (!optNum(v.hashedAt) || !optNum(v.attemptedAt)) return null;
    return {
        fid: v.fid, size: v.size, mtimeMs: v.mtimeMs, at: v.at,
        ...(v.hash !== undefined ? { hash: v.hash } : {}),
        ...(v.hashedAt !== undefined ? { hashedAt: v.hashedAt as number } : {}),
        ...(v.attemptedAt !== undefined ? { attemptedAt: v.attemptedAt as number } : {}),
    };
}

function refused(v: unknown): RefusedEntry | null {
    if (!isObj(v) || !isStr(v.fid) || !isNum(v.size) || !isNum(v.mtimeMs) || !isNum(v.maxKB)) return null;
    if (typeof v.reason !== 'string' || !(REFUSAL_REASONS as readonly string[]).includes(v.reason)) return null;
    return { fid: v.fid, size: v.size, mtimeMs: v.mtimeMs, reason: v.reason as RefusalReason, maxKB: v.maxKB };
}

function map<T>(raw: unknown, entry: (v: unknown) => T | null, keyOk: (k: string) => boolean): Record<string, T> | null {
    if (!isObj(raw)) return null;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(raw)) {
        const e = entry(v);
        if (e === null || !keyOk(k)) return null;
        out[k] = e;
    }
    return out;
}

/**
 * Absent = a first run (empty); a present null is not. Anything present that is not exactly this shape is corrupt: an empty fallback would forget
 * what was imported and copy every file in the folder again.
 */
export function decodeLedger(raw: unknown): DecodedLedger {
    if (raw === undefined) return { status: 'ok', ledger: emptyLedger() };
    if (raw === null) return { status: 'corrupt', reason: 'the record is empty' };
    if (!isObj(raw)) return { status: 'corrupt', reason: 'not an object' };
    if (raw.v !== 1) return { status: 'corrupt', reason: 'unknown version' };
    const isSha = (k: string): boolean => SHA.test(k);
    const any = (k: string): boolean => k !== '';
    const p = map(raw.pending, pending, isSha);
    const i = map(raw.imported, imported, isSha);
    const s = map(raw.seen, seen, any);
    const r = map(raw.refused, refused, any);
    if (!p || !i || !s || !r) return { status: 'corrupt', reason: 'an entry is not readable' };
    return { status: 'ok', ledger: { v: 1, pending: p, imported: i, seen: s, refused: r } };
}
