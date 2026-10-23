/**
 * Catch-up episode notes — build, parse and the vault IO around them.
 *
 * The episode note IS the coverage record: written ONCE, AFTER its audio exists, and never
 * edited. Everything here is confined to the newsletter output root (the existing
 * `output-root` write class used by every digest and newsletter-note write); a containment
 * assertion runs immediately before each mutation.
 */

import { App, normalizePath, TFile } from 'obsidian';
import * as yaml from 'js-yaml';
import { ensureFolderExists } from '../../../utils/minutesUtils';
import { logger } from '../../../utils/logger';
import {
    buildEpisodeName,
    coverageToFrontmatter,
    parseEpisodeFrontmatter,
    parseEpisodeName,
} from './catchUpCoverage';
import { CATCHUP_FOLDER, EPISODE_FM, type CoverageMap, type EpisodeMeta } from './catchUpTypes';

// ── Identity ─────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Collision-resistant operation id: local time to the second plus 4 random hex digits. */
export function generateOpId(now: Date = new Date(), random: () => number = Math.random): string {
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const suffix = Math.floor(random() * 0x10000).toString(16).padStart(4, '0');
    return `${stamp}-${suffix}`;
}

/** Ids appear in file names and frontmatter; keep them to a safe alphabet. */
export function isValidOpId(id: unknown): id is string {
    return typeof id === 'string' && /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id);
}

export function audioFileName(opId: string, fingerprint: string): string {
    return `catchup-${opId}-${fingerprint.slice(0, 8)}.mp3`;
}

// ── Paths and containment ────────────────────────────────────────────────────

export function episodeFolderPath(outputRoot: string): string {
    return normalizePath(`${outputRoot}/${CATCHUP_FOLDER}`);
}

/**
 * True when `path` sits inside `root`. Normalised, and any `..` segment is refused outright —
 * a path that needs to climb is never a legitimate write target here.
 */
export function isInsideOutputRoot(root: string, path: string): boolean {
    const r = normalizePath(root).replace(/\/+$/, '');
    const p = normalizePath(path);
    if (r === '' || p.split('/').includes('..')) return false;
    return p === r || p.startsWith(`${r}/`);
}

function assertInside(root: string, path: string): void {
    if (!isInsideOutputRoot(root, path)) {
        throw new Error(`Refusing to write outside the newsletter output folder: ${path}`);
    }
}

// ── Note content ─────────────────────────────────────────────────────────────

export interface EpisodeNoteInput {
    id: string;
    from: string;
    to: string;
    coverage: CoverageMap;
    audio: string;
    fingerprint: string;
    minutes: number;
    sources: number;
    titles: string[];
    script: string;
    /** Localised labels, so the note reads in the user's interface language. */
    labels?: { listen: string; covered: string; transcript: string };
}

const DEFAULT_LABELS = { listen: 'Listen', covered: 'Covered stories', transcript: 'Transcript' };

/** Frontmatter object in a stable key order. */
export function buildEpisodeFrontmatter(input: EpisodeNoteInput): Record<string, unknown> {
    const coverage: Record<string, number | string> = {};
    for (const date of Object.keys(input.coverage).sort()) coverage[date] = coverageToFrontmatter(input.coverage[date]);
    return {
        [EPISODE_FM.type]: EPISODE_FM.typeValue,
        [EPISODE_FM.id]: input.id,
        [EPISODE_FM.from]: input.from,
        [EPISODE_FM.to]: input.to,
        [EPISODE_FM.coverage]: coverage,
        [EPISODE_FM.audio]: input.audio,
        [EPISODE_FM.fingerprint]: input.fingerprint,
        [EPISODE_FM.minutes]: Math.round(input.minutes * 10) / 10,
        [EPISODE_FM.sources]: input.sources,
    };
}

/** Collapse a title to one safe markdown line. */
function oneLine(text: string): string {
    return text.replaceAll(/[\r\n]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

export function buildEpisodeNote(input: EpisodeNoteInput): string {
    const labels = input.labels ?? DEFAULT_LABELS;
    const fm = yaml.dump(buildEpisodeFrontmatter(input), { lineWidth: -1 }).trimEnd();
    const heading = input.from === input.to ? input.from : `${input.from} → ${input.to}`;
    const titles = input.titles.map(oneLine).filter((t) => t !== '');
    const covered = titles.length > 0
        ? `\n## ${labels.covered}\n\n${titles.map((t) => `- ${t}`).join('\n')}\n`
        : '';
    // The transcript is quoted as a collapsed callout; every line must carry the quote marker.
    const transcript = input.script.trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n');
    return `---\n${fm}\n---\n\n# Newsletter catch-up — ${heading}\n\n🎧 **${labels.listen}:** ![[${input.audio}]]\n${covered}\n> [!note]- ${labels.transcript}\n${transcript}\n`;
}

/** Parse an episode note's text. Anything that is not a well-formed episode returns null. */
export function parseEpisodeContent(content: string, notePath: string): EpisodeMeta | null {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!m) return null;
    try {
        const fm = yaml.load(m[1]);
        if (!fm || typeof fm !== 'object') return null;
        return parseEpisodeFrontmatter(fm as Record<string, unknown>, notePath);
    } catch {
        return null;
    }
}

// ── Vault IO ─────────────────────────────────────────────────────────────────

function childrenOf(app: App, folderPath: string): TFile[] {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!folder || !('children' in folder)) return [];
    return (folder as { children: unknown[] }).children.filter((c): c is TFile => c instanceof TFile);
}

/**
 * The three outcomes of reading an episode note, kept apart on purpose: "this is not a valid
 * episode" and "we could not read it" are different facts, and a destructive decision may
 * rely on the first but never on the second.
 */
export type EpisodeRead =
    | { kind: 'ok'; meta: EpisodeMeta }
    | { kind: 'invalid'; content: string }
    | { kind: 'unreadable' };

/** Read one episode: the metadata cache first (in memory, no I/O), the file only when the cache is cold. */
export async function readEpisodeResult(app: App, file: TFile): Promise<EpisodeRead> {
    const cached = app.metadataCache?.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const fromCache = cached ? parseEpisodeFrontmatter(cached, file.path) : null;
    if (fromCache) return { kind: 'ok', meta: fromCache };
    let content: string;
    try {
        content = await app.vault.cachedRead(file);
    } catch (e) {
        logger.warn('Newsletter', `Could not read episode note ${file.path}`, e);
        return { kind: 'unreadable' };
    }
    const meta = parseEpisodeContent(content, file.path);
    return meta ? { kind: 'ok', meta } : { kind: 'invalid', content };
}

/** Convenience for callers that only care about a valid episode. */
export async function readEpisode(app: App, file: TFile): Promise<EpisodeMeta | null> {
    const r = await readEpisodeResult(app, file);
    return r.kind === 'ok' ? r.meta : null;
}

export interface LoadedEpisodes {
    /** Episodes that parse AND still have their audio file. */
    episodes: EpisodeMeta[];
    /** In-window notes that parse but whose audio is missing (offered for regeneration). */
    missingAudio: EpisodeMeta[];
}

/**
 * Episodes whose NAME places them in the window. Out-of-window notes are skipped by name alone —
 * no read, no existence check — so the cost does not grow with the age of the install.
 */
export async function loadEpisodes(app: App, outputRoot: string, windowStart: string): Promise<LoadedEpisodes> {
    const folder = episodeFolderPath(outputRoot);
    const episodes: EpisodeMeta[] = [];
    const missingAudio: EpisodeMeta[] = [];
    for (const file of childrenOf(app, folder)) {
        const named = parseEpisodeName(file.name);
        if (!named || named.to < windowStart) continue;
        const meta = await readEpisode(app, file);
        if (!meta) continue;
        const audio = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${meta.audio}`));
        if (audio instanceof TFile) episodes.push(meta);
        else missingAudio.push(meta);
    }
    return { episodes, missingAudio };
}

/**
 * First VALID episode when candidates are tried in the given order. An unreadable or malformed
 * note is skipped rather than hiding an older valid one behind it.
 */
async function firstValidEpisode(
    app: App,
    outputRoot: string,
    order: (a: { to: string; id: string }, b: { to: string; id: string }) => number,
): Promise<EpisodeMeta | null> {
    const candidates = childrenOf(app, episodeFolderPath(outputRoot))
        .flatMap((file) => { const named = parseEpisodeName(file.name); return named ? [{ file, to: named.to, id: named.id }] : []; })
        .sort(order);
    for (const c of candidates) {
        const meta = await readEpisode(app, c.file);
        if (meta) return meta;
    }
    return null;
}

/** The most recently GENERATED episode (the operation id starts with its timestamp), for replay and the unheard warning. */
export function findLatestEpisode(app: App, outputRoot: string): Promise<EpisodeMeta | null> {
    return firstValidEpisode(app, outputRoot, (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * The episode whose narrated range ends LATEST — the authority for "since the last audio" and for
 * provable gaps. Deliberately not the same as the latest generated: remaking an earlier range
 * must not move the boundary backwards.
 */
export function findLatestNarratedEpisode(app: App, outputRoot: string): Promise<EpisodeMeta | null> {
    return firstValidEpisode(app, outputRoot, (a, b) => (a.to !== b.to ? (a.to < b.to ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The committed episode carrying this operation id, or null. Found by NAME, verified by frontmatter. */
export async function findEpisodeByOpId(app: App, outputRoot: string, opId: string): Promise<EpisodeMeta | null> {
    for (const file of childrenOf(app, episodeFolderPath(outputRoot))) {
        const named = parseEpisodeName(file.name);
        if (!named || named.id !== opId) continue;
        const meta = await readEpisode(app, file);
        if (meta && meta.id === opId) return meta;
    }
    return null;
}

export type AudioReference = 'yes' | 'no' | 'unknown';

/**
 * Does any episode note reference this audio file? Tri-state, because the answer gates deletion:
 * `unknown` (an episode note could not be read) must never be treated as `no`. A note whose
 * frontmatter is damaged still counts as a reference if its text names the file.
 */
export async function isAudioReferenced(app: App, outputRoot: string, audioName: string): Promise<AudioReference> {
    const folder = episodeFolderPath(outputRoot);

    // Anything in the vault that already LINKS to the file counts, wherever the note lives or
    // whatever it is called (a renamed or moved episode is still a reference).
    const resolved = (app.metadataCache as { resolvedLinks?: Record<string, Record<string, number>> } | undefined)?.resolvedLinks;
    if (resolved) {
        const audioPath = normalizePath(`${folder}/${audioName}`);
        for (const links of Object.values(resolved)) if (links && audioPath in links) return 'yes';
    }

    // The deletion decision reads CURRENT contents of every markdown note in the folder, never
    // the metadata cache (which can lag an edit) and never a file-name convention (a renamed note
    // is still a note). An unreadable note makes the answer UNKNOWN, which blocks deletion.
    let unknown = false;
    for (const file of childrenOf(app, folder)) {
        if (!file.name.endsWith('.md')) continue;
        try {
            if ((await app.vault.cachedRead(file)).includes(audioName)) return 'yes';
        } catch (e) {
            logger.warn('Newsletter', `Could not read ${file.path} while checking audio references`, e);
            unknown = true;
        }
    }
    return unknown ? 'unknown' : 'no';
}

/**
 * Create the episode note — THE commit point. Idempotent by operation id: a note already
 * carrying this id is success, not a collision.
 */
export async function writeEpisodeNote(app: App, outputRoot: string, input: EpisodeNoteInput): Promise<{ path: string; created: boolean }> {
    const existing = await findEpisodeByOpId(app, outputRoot, input.id);
    if (existing) return { path: existing.notePath, created: false };

    const folder = episodeFolderPath(outputRoot);
    const path = normalizePath(`${folder}/${buildEpisodeName(input.from, input.to, input.id)}`);
    assertInside(outputRoot, folder);
    assertInside(outputRoot, path);
    await ensureFolderExists(app.vault, folder);
    await app.vault.create(path, buildEpisodeNote(input));
    return { path, created: true };
}

/** Trash a file the plugin owns, after proving it sits inside the output root. */
export async function trashOwnedFile(app: App, outputRoot: string, path: string): Promise<boolean> {
    assertInside(outputRoot, path);
    const file = app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return false;
    await app.fileManager.trashFile(file);
    return true;
}
