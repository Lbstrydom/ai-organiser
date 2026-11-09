/**
 * What the Claude importer accepts from its source folder, and when. Pure: no Obsidian, no Node.
 *
 * The folder is an untrusted mailbox. A file is copied byte for byte or not at all: nothing here repairs, truncates or
 * defuses text to make it pass. The content checks are a known-pattern filter (the plugin's own properties and markers,
 * renderers known to run code), not a guarantee that nothing in an imported note can run: the folder must be one that only
 * the person's own AI apps write to.
 */
import * as yaml from 'js-yaml';
import { isSafeFileName } from '../offload/localMount';
import type { RefusalReason, SeenEntry } from './importLedger';

export const TEXT_EXTENSIONS = ['.md', '.txt'] as const;
/** More entries than this in the source folder and the run refuses (nothing is skipped silently). */
export const MAX_ENTRIES = 5000;
/** Files opened per run; the rest wait for the next run (the scheduler is fair, so every file is reached). */
export const MAX_READS_PER_RUN = 50;
/** A background run reads a cached, unchanged file again at most this often (a manual run rotates through all of them). */
export const BACKGROUND_REHASH_MS = 24 * 60 * 60 * 1000;

/** Frontmatter keys owned by the plugin (any case): a file carrying one would become a project, a capture or a live pack. */
export const RESERVED_KEY_PREFIXES = ['aio-', 'aio_', 'capture-'] as const;
/** Code block languages that well-known plugins execute when the note is shown. */
export const ACTIVE_FENCE_LANGS = ['dataviewjs', 'js-engine', 'run-js', 'customjs', 'meta-bind-js', 'button', 'templater'] as const;

const extOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
};

/** A file the importer looks at at all: a .md or .txt name that is not hidden or an Office lock file. */
export function isTextCandidate(name: string): boolean {
    if (name.startsWith('.') || name.startsWith('~$')) return false;
    return (TEXT_EXTENSIONS as readonly string[]).includes(extOf(name));
}

/** A candidate whose name can be used as it is (no path characters, no reserved Windows name, not over-long). */
export const isImportableName = (name: string): boolean => isSafeFileName(name);

/** The vault file names to try for a copy: the source name with a .md extension, then with 8 hex digits of its hash. */
export function targetNames(sourceName: string, sha256: string): string[] {
    const stem = sourceName.slice(0, sourceName.length - extOf(sourceName).length);
    return [`${stem}.md`, `${stem}-${sha256.slice(0, 8)}.md`].filter(isSafeFileName);
}

/** The folder as Claude's Google Drive sees it: the part after a "My Drive" segment, or '' when that cannot be told (nothing is guessed). */
export function driveDisplayPath(localFolder: string): string {
    const parts = localFolder.trim().split(/[\\/]+/).filter((p) => p !== '');
    const at = parts.findIndex((p) => p.toLowerCase() === 'my drive');
    const rest = at >= 0 ? parts.slice(at + 1) : [];
    return rest.join('/');
}

// ─── Stability and scheduling ────────────────────────────────────────────────────────────────────

export interface Observation {
    fid: string;
    size: number;
    mtimeMs: number;
}

const sameIdentity = (a: Observation, b: Observation): boolean => a.fid === b.fid && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The record of this observation: an unchanged file keeps its first-seen time and its hash; a changed one starts again. */
export function observe(prev: SeenEntry | undefined, cur: Observation, now: number): SeenEntry {
    if (prev && sameIdentity(prev, cur)) return prev;
    return { fid: cur.fid, size: cur.size, mtimeMs: cur.mtimeMs, at: now, ...(prev?.attemptedAt !== undefined ? { attemptedAt: prev.attemptedAt } : {}) };
}

/**
 * Ready when unchanged for the whole window. On a run the person started, a modified time older than the window also counts;
 * a background run never trusts it (Drive may give a file that is still arriving the cloud's older modified time).
 * An empty file always waits.
 */
export function stability(entry: SeenEntry, now: number, windowMs: number, trustMtime: boolean): { ready: boolean; readyAt: number } {
    const readyAt = entry.at + windowMs;
    if (entry.size === 0) return { ready: false, readyAt };
    const ready = now >= readyAt || (trustMtime && now - entry.mtimeMs >= windowMs);
    return { ready, readyAt };
}

/** Does this stable file need its bytes read on this run? */
export function needsRead(entry: SeenEntry, now: number, manual: boolean): boolean {
    if (entry.hash === undefined) return true;
    if (manual) return true;
    return now - (entry.hashedAt ?? 0) >= BACKGROUND_REHASH_MS;
}

/** The fair order: never attempted first, then least recently attempted, then oldest modified, then name. */
export function readOrder<T extends { name: string; entry: SeenEntry }>(items: readonly T[], limit: number): T[] {
    return [...items].sort((a, b) => {
        const aa = a.entry.attemptedAt;
        const bb = b.entry.attemptedAt;
        if (aa === undefined && bb !== undefined) return -1;
        if (bb === undefined && aa !== undefined) return 1;
        if (aa !== undefined && bb !== undefined && aa !== bb) return aa - bb;
        if (a.entry.mtimeMs !== b.entry.mtimeMs) return a.entry.mtimeMs - b.entry.mtimeMs;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }).slice(0, Math.max(0, limit));
}

// ─── Admission ───────────────────────────────────────────────────────────────────────────────────

export type Admission = { ok: true; text: string } | { ok: false; reason: RefusalReason };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m;
const MARKER = /<!--\s*\/?\s*aio:/i;
/** A fence opener anywhere on a line, so one inside a blockquote or a list item is seen too (over-refusing is deliberate). */
const FENCE = /(?:`{3,}|~{3,})[ \t]*\{?([^\s`{}]*)/g;

function frontmatterKeys(text: string): { ok: true; keys: string[] } | { ok: false } {
    if (!/^---[ \t]*\r?\n/.test(text)) return { ok: true, keys: [] };
    const m = FRONTMATTER.exec(text);
    // An opening line with no closing one is not frontmatter to Obsidian either: the text is body.
    if (!m || m.index !== 0) return { ok: true, keys: [] };
    try {
        const parsed: unknown = yaml.load(m[1]);
        if (parsed === null || parsed === undefined) return { ok: true, keys: [] };
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
        return { ok: true, keys: Object.keys(parsed as Record<string, unknown>) };
    } catch {
        return { ok: false };
    }
}

function hasActiveContent(text: string): boolean {
    if (/`\$=/.test(text) || text.includes('<%')) return true;
    for (const m of text.matchAll(FENCE)) {
        if ((ACTIVE_FENCE_LANGS as readonly string[]).includes(m[1].toLowerCase())) return true;
    }
    return false;
}

/** Judge the exact bytes. The decoded text is for these checks and for routing only; the bytes are what gets copied. */
export function admit(bytes: Uint8Array): Admission {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return { ok: false, reason: 'not-text' };
    }
    if (text.includes('\u0000')) return { ok: false, reason: 'not-text' };
    const fm = frontmatterKeys(text);
    if (!fm.ok) return { ok: false, reason: 'frontmatter-unreadable' };
    if (fm.keys.some((k) => RESERVED_KEY_PREFIXES.some((p) => k.trim().toLowerCase().startsWith(p)))) return { ok: false, reason: 'reserved-property' };
    if (MARKER.test(text)) return { ok: false, reason: 'reserved-marker' };
    if (hasActiveContent(text)) return { ok: false, reason: 'active-content' };
    return { ok: true, text };
}
