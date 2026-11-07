/**
 * The AI workspace record: which chat projects (Claude or ChatGPT) belong to a project or Area, which extra notes feed its
 * context pack, and which packs were made. Plain data, validated on every read; an unknown or damaged field is dropped, never
 * trusted. Pure.
 */
import { isAioId } from '../projects/projectIndex';
import { normalisePath } from '../../core/protectedPaths';
import { isSafeFileName } from '../offload/localMount';

export type ChatApp = 'claude' | 'chatgpt';

export interface WorkspaceChat {
    id: string;
    app: ChatApp;
    name: string;
    url: string;
}

export interface PackEntry {
    id: string;
    createdAt: string;
    path: string;
    digest: string;
}

export interface WorkspaceRecord {
    version: 1;
    /** The project or Area this workspace belongs to */
    anchorId: string;
    chats: WorkspaceChat[];
    /** Extra notes (vault paths) that feed the pack, beside the project and Area notes */
    contextSources: string[];
    packs: PackEntry[];
    /** Marked released when the user has finished with the chat project */
    released: boolean;
    /** The live pack approval; absent = off (and absent from the stored record, so the off path is unchanged) */
    live?: LiveApproval;
}

/**
 * The person's approval of a live pack: which notes may be written, under which share policy, by which installation, to which file.
 * The destination is fixed at the first approval and kept by every re-review.
 */
export interface LiveApproval {
    /** Project note first, then the Area note and context sources the person ticked */
    approvedSources: string[];
    /** The share-policy revision the approval was made under */
    approvedPolicy: string;
    approvedAt: string;
    /** The installation that writes the file; other installations only show status */
    deviceId: string;
    /** Canonical absolute folder outside the vault */
    folder: string;
    /** "<project> - live pack.md" */
    fileName: string;
    /** Bumped by every consent change; a review is bound to the generation it was opened under */
    generation: number;
}

/** A publication that must be replaced by the "no longer shared" stub. Kept until the stub is verified. */
export interface PendingRevocation {
    aioId: string;
    deviceId: string;
    folder: string;
    fileName: string;
    projectName: string;
    requestedAt: string;
}

export const LIVE_FILE_SUFFIX = ' - live pack.md';

/** A single safe file name (the offload's rules) ending in the live suffix. */
export function isLiveFileName(name: unknown): name is string {
    return typeof name === 'string' && name.endsWith(LIVE_FILE_SUFFIX) && name.length > LIVE_FILE_SUFFIX.length && isSafeFileName(name);
}

/** Windows drive (`C:\`), UNC (`\\server\share`) or POSIX (`/`) absolute folders. */
const ABSOLUTE_FOLDER = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]|\/)/;

/** An absolute folder as written. Existence, kind and distance from the vault are checked by the writer, never here. */
export function isAbsoluteFolder(raw: unknown): raw is string {
    return typeof raw === 'string' && raw.length <= 240 && raw.trim() === raw && ABSOLUTE_FOLDER.test(raw) && ![...raw].some((ch) => ch.charCodeAt(0) < 32);
}

const DEVICE_ID = /^[0-9a-f-]{8,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Validate a stored approval; null when any part cannot be trusted (which means "off"). */
export function normaliseLive(raw: unknown): LiveApproval | null {
    if (!isRecord(raw)) return null;
    const { approvedPolicy, approvedAt, deviceId, folder, fileName, generation } = raw;
    if (typeof approvedPolicy !== 'string' || !HEX64.test(approvedPolicy)) return null;
    if (typeof approvedAt !== 'string' || Number.isNaN(Date.parse(approvedAt))) return null;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return null;
    if (!isAbsoluteFolder(folder) || !isLiveFileName(fileName)) return null;
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return null;
    const sources: string[] = [];
    for (const s of Array.isArray(raw.approvedSources) ? raw.approvedSources : []) {
        if (typeof s !== 'string') continue;
        const p = normalisePath(s);
        if (p !== '' && !sources.includes(p)) sources.push(p);
        if (sources.length >= MAX_CONTEXT_SOURCES + 2) break;
    }
    if (sources.length === 0) return null;
    return { approvedSources: sources, approvedPolicy, approvedAt, deviceId, folder, fileName, generation };
}

/** The destination of an approval that failed validation, if it is still readable: such a file must be retired, not forgotten. */
export function readableDestination(raw: unknown): Pick<PendingRevocation, 'deviceId' | 'folder' | 'fileName'> | null {
    if (!isRecord(raw)) return null;
    const { deviceId, folder, fileName } = raw;
    return typeof deviceId === 'string' && DEVICE_ID.test(deviceId) && isAbsoluteFolder(folder) && isLiveFileName(fileName) ? { deviceId, folder, fileName } : null;
}

export function normaliseRevocations(raw: unknown): PendingRevocation[] {
    const out: PendingRevocation[] = [];
    for (const r of Array.isArray(raw) ? raw : []) {
        if (!isRecord(r) || !isAioId(r.aioId)) continue;
        const dest = readableDestination(r);
        if (!dest) continue;
        const key = `${dest.folder.toLowerCase()}|${dest.fileName.toLowerCase()}`;
        if (out.some((x) => `${x.folder.toLowerCase()}|${x.fileName.toLowerCase()}` === key)) continue;
        out.push({ aioId: String(r.aioId).trim().toLowerCase(), ...dest, projectName: typeof r.projectName === 'string' ? r.projectName.slice(0, 120) : '', requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : '' });
        if (out.length >= 100) break;
    }
    return out;
}

export const MAX_CHATS = 6;
export const MAX_CONTEXT_SOURCES = 30;
export const MAX_PACKS_KEPT = 5;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A chat URL is accepted only for the two apps, over https, on their own host. */
export function validateChatUrl(app: ChatApp, raw: string): string | null {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return null; }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    if (app === 'claude' && url.hostname === 'claude.ai' && /^\/project\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return `https://claude.ai${url.pathname.replace(/\/$/, '')}`;
    if (app === 'chatgpt' && (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && /^\/g\/[A-Za-z0-9-]+(\/project)?\/?$/.test(url.pathname)) return `https://${url.hostname}${url.pathname.replace(/\/$/, '')}`;
    return null;
}

export function emptyWorkspace(anchorId: string): WorkspaceRecord {
    return { version: 1, anchorId, chats: [], contextSources: [], packs: [], released: false };
}

/** Coerce one stored record; null when it cannot belong to an anchor. */
export function normaliseWorkspace(raw: unknown): WorkspaceRecord | null {
    if (!isRecord(raw) || !isAioId(raw.anchorId)) return null;
    const chats: WorkspaceChat[] = [];
    for (const c of Array.isArray(raw.chats) ? raw.chats : []) {
        if (!isRecord(c) || (c.app !== 'claude' && c.app !== 'chatgpt') || typeof c.id !== 'string' || c.id === '') continue;
        const url = typeof c.url === 'string' ? validateChatUrl(c.app, c.url) : null;
        if (!url || chats.some((x) => x.id === c.id)) continue;
        chats.push({ id: c.id, app: c.app, name: typeof c.name === 'string' ? c.name.trim().slice(0, 80) : '', url });
        if (chats.length >= MAX_CHATS) break;
    }
    const sources: string[] = [];
    for (const s of Array.isArray(raw.contextSources) ? raw.contextSources : []) {
        if (typeof s !== 'string') continue;
        const p = normalisePath(s);
        if (p !== '' && !sources.includes(p)) sources.push(p);
        if (sources.length >= MAX_CONTEXT_SOURCES) break;
    }
    const packs: PackEntry[] = [];
    for (const p of Array.isArray(raw.packs) ? raw.packs : []) {
        if (!isRecord(p) || typeof p.id !== 'string' || typeof p.path !== 'string' || typeof p.digest !== 'string' || typeof p.createdAt !== 'string') continue;
        packs.push({ id: p.id, createdAt: p.createdAt, path: p.path, digest: p.digest });
    }
    const record: WorkspaceRecord = { version: 1, anchorId: String(raw.anchorId).trim().toLowerCase(), chats, contextSources: sources, packs: packs.slice(-MAX_PACKS_KEPT), released: raw.released === true };
    // Only a valid approval is kept, and only then is the key present: a record without one is exactly what it always was.
    const live = raw.live === undefined ? null : normaliseLive(raw.live);
    if (live) record.live = live;
    return record;
}

export function normaliseWorkspaces(raw: unknown): Record<string, WorkspaceRecord> {
    const out: Record<string, WorkspaceRecord> = {};
    if (!isRecord(raw)) return out;
    for (const value of Object.values(raw)) {
        const rec = normaliseWorkspace(value);
        if (rec) out[rec.anchorId] = rec;
    }
    return out;
}

/** A new record with one more pack, keeping the newest `MAX_PACKS_KEPT`. */
export function withPack(record: WorkspaceRecord, pack: PackEntry): WorkspaceRecord {
    return { ...record, packs: [...record.packs.filter((p) => p.id !== pack.id), pack].slice(-MAX_PACKS_KEPT) };
}
