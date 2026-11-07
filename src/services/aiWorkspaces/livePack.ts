/**
 * The live pack, the pure part: which notes it may contain (only the ones the person approved), which are held for review, when it
 * must be withdrawn, and the bytes of the file and of the "no longer shared" stub. Built on `buildContextPack`, so link handling,
 * the budget and the hashes are the pack's own.
 *
 * Nothing here reads the vault or writes a file: the caller supplies the notes and the policy, as for a pack.
 */
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import { buildContextPack, PACK_BUDGET_BYTES, packSha256, type PackInput, type PackNote, type PackSource, type SkipReason } from './contextPack';
import { LIVE_FILE_SUFFIX } from './workspaceRecord';

/** The frontmatter key that marks a file as this plugin's live pack for one project. */
export const LIVE_MARKER_KEY = 'aio-live-pack';
/** The whole file may carry the marker, the date and the held list on top of the pack. */
export const LIVE_FILE_MAX_BYTES = PACK_BUDGET_BYTES + 16 * 1024;

export interface LiveBuildInput extends PackInput {
    /** The paths the person approved (project note first) */
    approved: readonly string[];
    /** The file name in Drive, as the instructions name it */
    livePackName: string;
    /** When this build is written (only in the file, never in the digest) */
    updatedAt: string;
}

export type LiveBuild =
    | { kind: 'pack'; text: string; bytes: number; digest: string; sources: PackSource[]; held: string[]; skipped: Array<{ path: string; reason: SkipReason }> }
    | { kind: 'revoke'; path: string }
    | { kind: 'needs-review'; reason: 'project-not-approved' };

const norm = (p: string): string => p.replace(/\\/g, '/');

/** The marker line, exactly as written. */
const markerLine = (aioId: string): string => `${LIVE_MARKER_KEY}: ${aioId.toLowerCase()}`;

/** Insert lines just before the closing `---` of the leading frontmatter (the pack always starts with one). */
function withFrontmatterLines(text: string, lines: readonly string[]): string {
    const close = text.indexOf('\n---', 3);
    if (!text.startsWith('---\n') || close < 0) return `---\n${lines.join('\n')}\n---\n\n${text}`;
    return `${text.slice(0, close)}\n${lines.join('\n')}${text.slice(close)}`;
}

export async function buildLivePack(input: LiveBuildInput): Promise<Result<LiveBuild>> {
    // A callback may throw: the declared contract is a Result, never a rejection.
    try {
        return await buildLivePackUnsafe(input);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not build the live pack', e);
        return err('pack-write-failed');
    }
}

async function buildLivePackUnsafe(input: LiveBuildInput): Promise<Result<LiveBuild>> {
    const approved = new Set(input.approved.map(norm));
    const candidates: PackNote[] = [input.project, ...(input.area ? [input.area] : []), ...input.sources];
    const seen = new Set<string>();
    const held: string[] = [];
    for (const note of candidates) {
        if (seen.has(note.path)) continue;
        seen.add(note.path);
        const shareable = input.reasonNotShareable(note.path) === null;
        // A note the person approved that may no longer be shared withdraws the whole pack: what Claude reads must stop now.
        if (!shareable && approved.has(norm(note.path))) return ok({ kind: 'revoke', path: note.path });
        if (shareable && !approved.has(norm(note.path))) held.push(note.path);
    }
    // The project note is the pack's reason to exist; a new path for it (a rename) is a new note to review.
    if (!approved.has(norm(input.project.path))) return ok({ kind: 'needs-review', reason: 'project-not-approved' });

    const area = input.area && approved.has(norm(input.area.path)) ? input.area : undefined;
    const built = await buildContextPack({
        ...input,
        area,
        sources: input.sources.filter((s) => approved.has(norm(s.path))),
        livePackName: input.livePackName,
    });
    if (!built.ok) return err(built.error);

    const heldSection = ['## Held for review', '', held.length === 0 ? 'None.' : 'These notes are shared but wait for the person to add them to this pack:', ...held.map((p) => `- ${p}`)].join('\n');
    // The digest covers everything but the date: the same sources and the same held list publish nothing new.
    const body = `${withFrontmatterLines(built.value.text.replace(/\n+$/, ''), [markerLine(input.aioId)])}\n\n${heldSection}\n`;
    const digest = await packSha256(body);
    const text = withFrontmatterLines(body, [`aio-pack-updated: ${input.updatedAt}`]);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > LIVE_FILE_MAX_BYTES) return err('pack-over-budget');
    return ok({ kind: 'pack', text, bytes, digest, sources: built.value.sources, held, skipped: built.value.skipped });
}

/** The file that replaces a live pack when it is no longer shared. Never deleted: Drive keeps the same file, saying so. */
export function buildLiveStub(fileName: string, aioId: string, since: string): string {
    const title = fileName.endsWith(LIVE_FILE_SUFFIX) ? fileName : `${fileName}${LIVE_FILE_SUFFIX}`;
    return [
        '---',
        markerLine(aioId),
        'aio-live-state: no-longer-shared',
        `aio-pack-updated: ${since}`,
        '---',
        '',
        `# ${title.replace(/\.md$/i, '')}`,
        '',
        `This project is no longer shared from the vault (since ${since.slice(0, 10)}). Do not use this file, earlier copies of it, or answers based on them.`,
        '',
    ].join('\n');
}

/** True when the first bytes of a file carry this project's marker inside the leading frontmatter. */
export function hasLiveMarker(head: string, aioId: string): boolean {
    return frontmatterLines(head)?.some((l) => l === markerLine(aioId)) ?? false;
}

/** True when the frontmatter has a top-level live marker of any project. */
export function hasAnyLiveMarker(head: string): boolean {
    return frontmatterLines(head)?.some((l) => l.startsWith(`${LIVE_MARKER_KEY}:`)) ?? false;
}

/**
 * The lines of the leading frontmatter (null when there is none, or it is not closed within the bytes read). Only a line starting at
 * column 0 can equal the marker: an indented line belongs to a block or list value and never counts.
 */
function frontmatterLines(head: string): string[] | null {
    const lines = head.split('\n').map((l) => l.replace(/\r$/, ''));
    if (lines[0] !== '---') return null;
    const close = lines.indexOf('---', 1);
    return close < 0 ? null : lines.slice(1, close);
}
