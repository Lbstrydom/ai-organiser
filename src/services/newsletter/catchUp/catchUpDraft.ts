/**
 * Catch-up durable state — the operation record and the acknowledgement map.
 *
 * Two small plugin-data stores, both registered in `DATA_ONLY_KEYS`:
 *
 *  - the OPERATION RECORD (`newsletter-catchup-draft`): created when the script has been
 *    written and cleared when the episode is committed or discarded. It holds the complete
 *    resumable state — the script and the coverage it claims — so a retry never repeats the
 *    LLM call and never rebuilds coverage from changed inputs. Every update and clear is
 *    compare-and-set on the operation id, so one operation can never overwrite or delete
 *    another's record.
 *  - the ACK MAP (`newsletter-catchup-acks`): which episodes the reader has heard. The
 *    story-memory watermark expires after 7 days and does not exist with memory off, so it
 *    cannot be the authority on "heard".
 */

import type { Plugin } from 'obsidian';
import { updatePluginData, loadPluginData } from '../../../core/pluginDataStore';
import { shiftDate, isDateStr, parseCoverageValue } from './catchUpCoverage';
import type { Coverage, PendingEntry } from './catchUpTypes';

export const DRAFT_DATA_KEY = 'newsletter-catchup-draft';
export const ACKS_DATA_KEY = 'newsletter-catchup-acks';

export const RECORD_SCHEMA_VERSION = 1;
/** A record older than this is no longer resumable. */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
/** Acks outlive the lookback window by this many days, so a listened episode never flips back to unheard. */
export const ACK_RETENTION_EXTRA_DAYS = 30;

export type OperationPhase = 'scripted' | 'audio-writing' | 'audio-ready';

/** What a record freezes about each day: the same kind-discriminated shape the plan uses. */
export type FrozenEntry = PendingEntry;

export interface OperationRecord {
    version: number;
    opId: string;
    phase: OperationPhase;
    frozen: {
        entries: FrozenEntry[];
        from: string;
        to: string;
        sources: number;
        titles: string[];
    };
    script: string;
    scriptIdentity: string;
    synthIdentity?: string;
    audio?: { path: string; bytes?: number; durationSec?: number; sha256?: string };
    createdAt: number;
}

const PHASES: readonly string[] = ['scripted', 'audio-writing', 'audio-ready'];

function coerceEntry(raw: unknown): FrozenEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (!isDateStr(e.date)) return null;
    const c = e.coverage as Record<string, unknown> | undefined;
    const coverage = c && c.kind === 'whole' ? ({ kind: 'whole' } as Coverage)
        : c && c.kind === 'revision' ? parseCoverageValue(c.rev) : null;
    if (!coverage) return null;
    // Kind-discriminated: a full day carries no threshold, a delta must carry one.
    if (e.kind === 'full') return e.sinceRevision === undefined ? { date: e.date, kind: 'full', coverage } : null;
    if (e.kind === 'delta') {
        const since = e.sinceRevision;
        return typeof since === 'number' && Number.isInteger(since) && since >= 0
            ? { date: e.date, kind: 'delta', coverage, sinceRevision: since }
            : null;
    }
    return null;
}

/** Coerce whatever is on disk into a valid record, or null. An unknown version is discarded, not migrated. */
export function coerceRecord(raw: unknown): OperationRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== RECORD_SCHEMA_VERSION) return null;
    if (typeof r.opId !== 'string' || r.opId === '' || typeof r.script !== 'string' || r.script === '') return null;
    if (typeof r.phase !== 'string' || !PHASES.includes(r.phase)) return null;
    // Required fields are validated, never manufactured: a record missing its identity or carrying
    // a non-finite timestamp would otherwise look valid and dodge the 24-hour lifetime.
    if (typeof r.scriptIdentity !== 'string' || r.scriptIdentity === '') return null;
    if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt <= 0) return null;
    const f = r.frozen as Record<string, unknown> | undefined;
    if (!f || !isDateStr(f.from) || !isDateStr(f.to) || !Array.isArray(f.entries)) return null;
    const entries = f.entries.map(coerceEntry).filter((e): e is FrozenEntry => e !== null);
    if (entries.length === 0 || entries.length !== f.entries.length) return null;
    const a = r.audio as Record<string, unknown> | undefined;
    const audio = a && typeof a.path === 'string' && a.path !== ''
        ? {
            path: a.path,
            ...(typeof a.bytes === 'number' ? { bytes: a.bytes } : {}),
            ...(typeof a.durationSec === 'number' ? { durationSec: a.durationSec } : {}),
            ...(typeof a.sha256 === 'string' ? { sha256: a.sha256 } : {}),
        }
        : undefined;
    // Phase-specific artifacts: a record past `scripted` must name its audio, and `audio-ready`
    // must carry the integrity evidence the verification step compares against.
    if (r.phase !== 'scripted' && !audio) return null;
    if (r.phase === 'audio-ready' && !(typeof audio?.bytes === 'number' && typeof audio?.sha256 === 'string' && typeof audio?.durationSec === 'number')) return null;
    return {
        version: RECORD_SCHEMA_VERSION,
        opId: r.opId,
        phase: r.phase as OperationPhase,
        frozen: {
            entries,
            from: f.from,
            to: f.to,
            sources: typeof f.sources === 'number' ? f.sources : 0,
            titles: Array.isArray(f.titles) ? f.titles.filter((t): t is string => typeof t === 'string') : [],
        },
        script: r.script,
        scriptIdentity: r.scriptIdentity,
        ...(typeof r.synthIdentity === 'string' ? { synthIdentity: r.synthIdentity } : {}),
        ...(audio ? { audio } : {}),
        createdAt: r.createdAt,
    };
}

/**
 * What is actually stored under the record key. A future-version record is NOT corruption: it
 * belongs to a newer plugin and must be preserved (never overwritten or cleared), whereas a
 * corrupt value has no owner and may be replaced.
 */
export function storedRecordStatus(raw: unknown): 'none' | 'valid' | 'unsupported' | 'corrupt' {
    if (raw === undefined || raw === null) return 'none';
    if (typeof raw !== 'object') return 'corrupt';
    const version = (raw as { version?: unknown }).version;
    if (typeof version === 'number' && version !== RECORD_SCHEMA_VERSION) return 'unsupported';
    return coerceRecord(raw) ? 'valid' : 'corrupt';
}

export function isRecordExpired(record: OperationRecord, now: number = Date.now()): boolean {
    return now - record.createdAt > RECORD_TTL_MS;
}

export async function loadOperation(plugin: Plugin): Promise<OperationRecord | null> {
    const data = await loadPluginData(plugin);
    return coerceRecord(data[DRAFT_DATA_KEY]);
}

/**
 * Compare-and-set save. Allowed when there is no record, when the stored record has the same
 * opId, or when the caller names the stored opId as the one it is deliberately replacing
 * (an explicit Start over). Anything else is refused: a record that is not yours is not yours
 * to overwrite. Returns whether the write happened.
 */
export async function saveOperation(
    plugin: Plugin,
    record: OperationRecord,
    replacing: string | null = null,
): Promise<boolean> {
    const saved = await updatePluginData<boolean>(plugin, (data) => {
        // A newer plugin's record is preserved untouched.
        if (storedRecordStatus(data[DRAFT_DATA_KEY]) === 'unsupported') return { changed: false, value: false };
        const existing = coerceRecord(data[DRAFT_DATA_KEY]);
        // A stored value that does not parse is corrupt, not an operation in flight.
        if (existing && existing.opId !== record.opId && existing.opId !== replacing) {
            return { changed: false, value: false };
        }
        data[DRAFT_DATA_KEY] = record;
        return { changed: true, value: true };
    });
    return saved === true;
}

/** Clear the record, but only if it still belongs to `opId`. */
export async function clearOperation(plugin: Plugin, opId: string): Promise<boolean> {
    const cleared = await updatePluginData<boolean>(plugin, (data) => {
        if (!(DRAFT_DATA_KEY in data)) return { changed: false, value: false };
        if (storedRecordStatus(data[DRAFT_DATA_KEY]) === 'unsupported') return { changed: false, value: false };
        const existing = coerceRecord(data[DRAFT_DATA_KEY]);
        // Corrupt data has no owner; anything with a different owner is left alone.
        if (existing && existing.opId !== opId) return { changed: false, value: false };
        delete data[DRAFT_DATA_KEY];
        return { changed: true, value: true };
    });
    return cleared === true;
}

// ── Acknowledgements ─────────────────────────────────────────────────────────

export interface AckRecord {
    ackedAt: number;
    /** The episode's last covered date, so acks can be pruned by age. */
    to: string;
}

export type AckMap = Record<string, AckRecord>;

export function coerceAcks(raw: unknown): AckMap {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as { version?: unknown; acks?: unknown };
    if (obj.version !== RECORD_SCHEMA_VERSION || !obj.acks || typeof obj.acks !== 'object') return {};
    const out: AckMap = {};
    for (const [id, value] of Object.entries(obj.acks as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (!isDateStr(v.to)) continue;
        out[id] = { ackedAt: typeof v.ackedAt === 'number' ? v.ackedAt : 0, to: v.to };
    }
    return out;
}

/** Drop acks for episodes too old to matter. Pure. */
export function pruneAcks(acks: AckMap, today: string, lookbackDays: number): AckMap {
    const cutoff = shiftDate(today, -(lookbackDays + ACK_RETENTION_EXTRA_DAYS));
    const out: AckMap = {};
    for (const [id, ack] of Object.entries(acks)) if (ack.to >= cutoff) out[id] = ack;
    return out;
}

export async function loadAcks(plugin: Plugin): Promise<AckMap> {
    const data = await loadPluginData(plugin);
    return coerceAcks(data[ACKS_DATA_KEY]);
}

/** Acknowledge episodes as heard. Returns the number of NEW acks written. */
export async function ackEpisodes(
    plugin: Plugin,
    episodes: ReadonlyArray<{ id: string; to: string }>,
    today: string,
    lookbackDays: number,
): Promise<number> {
    if (episodes.length === 0) return 0;
    const added = await updatePluginData<number>(plugin, (data) => {
        const before = coerceAcks(data[ACKS_DATA_KEY]);
        const acks = pruneAcks(before, today, lookbackDays);
        const pruned = Object.keys(before).length - Object.keys(acks).length;
        const now = Date.now();
        let n = 0;
        for (const ep of episodes) {
            if (ep.id in acks) continue;
            acks[ep.id] = { ackedAt: now, to: ep.to };
            n++;
        }
        // Persist when anything changed: an addition OR a retention removal.
        if (n === 0 && pruned === 0) return { changed: false, value: 0 };
        data[ACKS_DATA_KEY] = { version: RECORD_SCHEMA_VERSION, acks };
        return { changed: true, value: n };
    });
    return added ?? 0;
}
