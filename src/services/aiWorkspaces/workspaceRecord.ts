/**
 * The AI workspace record: which chat projects (Claude or ChatGPT) belong to a project or Area, which extra notes feed its
 * context pack, and which packs were made. Plain data, validated on every read; an unknown or damaged field is dropped, never
 * trusted. Pure.
 */
import { isAioId } from '../projects/projectIndex';
import { normalisePath } from '../../core/protectedPaths';

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
    if (app === 'chatgpt' && (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && /^\/g\/[A-Za-z0-9._~%-]+(\/project)?\/?$|^\/project\/?/.test(url.pathname)) return `https://${url.hostname}${url.pathname.replace(/\/$/, '')}`;
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
    return { version: 1, anchorId: String(raw.anchorId).trim().toLowerCase(), chats, contextSources: sources, packs: packs.slice(-MAX_PACKS_KEPT), released: raw.released === true };
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
