/**
 * Which project a hand-back belongs to. Suggest, never auto-file. Pure and deterministic.
 *
 * An `aio-id` that resolves to exactly one project matches exactly. Otherwise candidates are scored from the remembered
 * mapping (`<app>:<chat name>` -> project id), the chat names in workspace records, the title and file name, and the inbox
 * subfolder. The top candidate is pre-selected only when it is clearly ahead; a tie or low confidence has no default.
 * An id that resolves to no project, or to a duplicated one, and a mapping key that points at a project that is not
 * adoptable are rejected: no match, no default.
 *
 * Not scored in this version: semantic search over project notes (the plan's optional signal).
 */
import { isAioId, type ProjectRef } from '../projects/projectIndex';

export const PRESELECT_MIN_SCORE = 0.6;
export const PRESELECT_MIN_MARGIN = 0.25;
export const MAX_CANDIDATES = 500;

export interface MatchSignals {
    /** The `Project ID:` of the block, already validated as a UUID (or undefined) */
    projectId?: string;
    chat?: { name: string; app?: 'claude' | 'chatgpt' };
    /** The hand-back note's title and file name, and the name of the folder it sits in */
    title: string;
    fileName: string;
    subfolder: string;
}

export interface MatchCandidate {
    project: ProjectRef;
    /** Chat project names recorded in this project's workspace */
    chatNames: readonly string[];
}

export interface MatchEnvironment {
    candidates: readonly MatchCandidate[];
    /** Ids carried by two or more notes */
    duplicates: ReadonlySet<string>;
    /** `<app>:<canonical name>` -> project id */
    chatMap: Readonly<Record<string, string>>;
}

export interface RankedProject {
    project: ProjectRef;
    score: number;
    /** Why, for the review ("matched the chat project name") */
    reason: 'id' | 'mapping' | 'workspace-chat' | 'title' | 'folder';
}

export interface MatchResult {
    /** An exact match by id */
    exact?: ProjectRef;
    /** Set when the block carried an id that cannot be used */
    rejected?: 'unknown-id' | 'duplicate-id';
    ranked: RankedProject[];
    /** Pre-selected only when clearly ahead */
    preselect?: ProjectRef;
}

/** `<app>:<canonical name>`: NFC, trimmed, case-folded. A name without an app is `any:<name>` (suggestions only). */
export function mappingKey(chat: { name: string; app?: string }): string {
    const name = chat.name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    return `${chat.app ?? 'any'}:${name}`;
}

const tokens = (s: string): Set<string> => new Set(s.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3));

function overlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
}

const folderName = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1);

/** Stored mapping: only well-formed keys that point at a project id survive. */
export function normaliseChatMap(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (/^(claude|chatgpt|any):.+/.test(key) && typeof value === 'string' && isAioId(value)) out[key] = value.toLowerCase();
    }
    return out;
}

export function rankProjects(signals: MatchSignals, env: MatchEnvironment): MatchResult {
    if (signals.projectId) {
        if (env.duplicates.has(signals.projectId)) return { rejected: 'duplicate-id', ranked: [] };
        const hit = env.candidates.find((c) => c.project.aioId === signals.projectId);
        if (!hit) return { rejected: 'unknown-id', ranked: [] };
        return { exact: hit.project, ranked: [{ project: hit.project, score: 1, reason: 'id' }], preselect: hit.project };
    }
    const eligible = env.candidates.filter((c) => !env.duplicates.has(c.project.aioId));
    // Ranking reads at most MAX_CANDIDATES; with more than that the margin over an unread competitor cannot be judged, so there is no default.
    const candidates = eligible.slice(0, MAX_CANDIDATES);
    const complete = eligible.length <= MAX_CANDIDATES;
    const exactKey = signals.chat ? mappingKey(signals.chat) : null;
    // A block without an app can use the mapping only as a suggestion: it ranks below an exact (app-qualified) hit.
    const looseKey = signals.chat && !signals.chat.app ? null : signals.chat ? mappingKey({ name: signals.chat.name }) : null;
    const chatName = signals.chat ? mappingKey({ name: signals.chat.name }).slice(4) : '';
    const titleTokens = new Set([...tokens(signals.title), ...tokens(signals.fileName)]);
    const ranked: RankedProject[] = [];
    for (const c of candidates) {
        const scores: Array<{ score: number; reason: RankedProject['reason'] }> = [];
        const id = c.project.aioId;
        if (exactKey && env.chatMap[exactKey] === id) scores.push({ score: signals.chat?.app ? 1 : 0.7, reason: 'mapping' });
        if (looseKey && env.chatMap[looseKey] === id) scores.push({ score: 0.7, reason: 'mapping' });
        if (chatName !== '' && c.chatNames.some((n) => mappingKey({ name: n }).slice(4) === chatName)) scores.push({ score: 0.8, reason: 'workspace-chat' });
        const projectTokens = tokens(c.project.notePath.slice(c.project.notePath.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
        const o = overlap(titleTokens, projectTokens);
        if (o > 0) scores.push({ score: Math.min(0.5, o * 0.5), reason: 'title' });
        if (signals.subfolder !== '' && folderName(c.project.folder).toLowerCase() === signals.subfolder.toLowerCase()) scores.push({ score: 0.3, reason: 'folder' });
        if (scores.length === 0) continue;
        // The strongest single signal names the reason; the others add a little, clamped to 0..1.
        scores.sort((a, b) => b.score - a.score);
        const total = Math.min(1, scores[0].score + scores.slice(1).reduce((s, x) => s + x.score * 0.25, 0));
        ranked.push({ project: c.project, score: Math.round(total * 1000) / 1000, reason: scores[0].reason });
    }
    // A mapping key that points at several projects is a collision: none of them is exact.
    ranked.sort((a, b) => b.score - a.score || a.project.notePath.localeCompare(b.project.notePath));
    const [first, second] = ranked;
    const preselect = complete && first && first.score >= PRESELECT_MIN_SCORE && (!second || first.score - second.score >= PRESELECT_MIN_MARGIN) ? first.project : undefined;
    return { ranked, ...(preselect ? { preselect } : {}) };
}
