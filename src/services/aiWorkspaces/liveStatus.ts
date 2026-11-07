/**
 * What each live pack last did: shown in the workspace window and the settings, never consulted for consent (the approval in the
 * workspace record is the only consent). Pure.
 */
import { isAioId } from '../projects/projectIndex';
import { normalisePath } from '../../core/protectedPaths';

export type LiveState = 'live' | 'needs-review' | 'off' | 'error' | 'other-device' | 'revoking';
const STATES: readonly LiveState[] = ['live', 'needs-review', 'off', 'error', 'other-device', 'revoking'];

export interface LiveStatus {
    state: LiveState;
    lastWrittenAt?: string;
    /** Digest of the pack part (sources only, no date): equal digests mean nothing to publish */
    lastDigest?: string;
    /** SHA-256 of the whole file as last written and read back */
    lastFileSha?: string;
    /** Shareable notes waiting for the person to tick them */
    held: string[];
    /** Stable code of the last failure, cleared by the next success */
    lastError?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_HELD = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function normaliseOneStatus(raw: unknown): LiveStatus | null {
    if (!isRecord(raw) || !STATES.includes(raw.state as LiveState)) return null;
    const held: string[] = [];
    for (const h of Array.isArray(raw.held) ? raw.held : []) {
        if (typeof h !== 'string') continue;
        const p = normalisePath(h);
        if (p !== '' && !held.includes(p)) held.push(p);
        if (held.length >= MAX_HELD) break;
    }
    const out: LiveStatus = { state: raw.state as LiveState, held };
    if (typeof raw.lastWrittenAt === 'string' && !Number.isNaN(Date.parse(raw.lastWrittenAt))) out.lastWrittenAt = raw.lastWrittenAt;
    if (typeof raw.lastDigest === 'string' && HEX64.test(raw.lastDigest)) out.lastDigest = raw.lastDigest;
    if (typeof raw.lastFileSha === 'string' && HEX64.test(raw.lastFileSha)) out.lastFileSha = raw.lastFileSha;
    if (typeof raw.lastError === 'string' && CODE.test(raw.lastError)) out.lastError = raw.lastError;
    return out;
}

/** Status entries for projects that still have a workspace record; anything else is dropped. */
export function normaliseLiveStatus(raw: unknown, knownIds: readonly string[]): Record<string, LiveStatus> {
    const out: Record<string, LiveStatus> = {};
    if (!isRecord(raw)) return out;
    const known = new Set(knownIds.map((k) => k.toLowerCase()));
    for (const [id, value] of Object.entries(raw)) {
        const key = id.trim().toLowerCase();
        if (!isAioId(key) || !known.has(key)) continue;
        const status = normaliseOneStatus(value);
        if (status) out[key] = status;
    }
    return out;
}
