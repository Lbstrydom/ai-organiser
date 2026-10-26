/**
 * The context pack: one markdown file holding the instructions, the project note, the Area note and the chosen context
 * sources, each with its path and content hash. Only notes the share policy allows are included; a link to a note that is not
 * shareable reads `[not shared]`, and attachments are never included. Pure: the caller supplies the note texts and the policy.
 *
 * A prepared pack is bound to a snapshot: it carries the hash of every source and the share-policy revision, and `verifyPrepared`
 * refuses to write it when either has changed since the preview.
 */
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import { toModelText } from '../../utils/excalidrawContent';
import { bodyWithoutOwned, buildWorkspaceInstructions } from './workspaceInstructions';
import { stripWorkspaceBlock } from './workspaceBlock';
import { neutraliseByCache, type LinkOccurrence } from './linkNeutraliser';

/** Same budget as the vault map. */
export const PACK_BUDGET_BYTES = 400 * 1024;
export const PACK_GENERATOR_VERSION = 1;

export interface PackNote {
    path: string;
    text: string;
}

export type SkipReason = 'outside-allow-list' | 'in-pack-folder' | 'kept-out' | 'missing' | 'links-unverified';

export interface PackInput {
    vaultId: string;
    aioId: string;
    projectName: string;
    project: PackNote;
    area?: PackNote;
    /** Extra notes from the workspace record */
    sources: readonly PackNote[];
    /** Why a path may not be shared, or null when it may */
    reasonNotShareable: (path: string) => SkipReason | null;
    /** Resolve a link target written in `from` to a vault path, or null when it does not resolve */
    resolveLink: (link: string, from: string) => string | null;
    /** The links and embeds Obsidian's cache reports for a note, with positions; null when the note has no cache */
    linksOf: (note: PackNote) => LinkOccurrence[] | null;
    sharePolicyRevision: string;
}

export interface PackSource {
    path: string;
    contentHash: string;
}

export interface PreparedPack {
    /** The instructions on their own (what "copy instructions" puts on the clipboard) */
    instructions: string;
    text: string;
    bytes: number;
    digest: string;
    sources: PackSource[];
    skipped: Array<{ path: string; reason: SkipReason }>;
    sharePolicyRevision: string;
    generatorVersion: number;
}

const enc = new TextEncoder();
const byteLength = (s: string): number => enc.encode(s).length;

async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Text of one included note: links neutralised from the cache first (positions are in the original text), then drawing blobs and plugin-owned blocks dropped. */
function includedText(note: PackNote, input: PackInput & { inPack: ReadonlySet<string> }): Result<string> {
    const linked = neutraliseByCache(note.text, note.path, input.linksOf(note), { ...input, inPack: input.inPack });
    if (!linked.ok) return err(linked.error);
    return ok(bodyWithoutOwned(toModelText(linked.value, note.path)));
}

export async function buildContextPack(input: PackInput): Promise<Result<PreparedPack>> {
    // A callback or the hash may throw: the declared contract is a Result, never a rejection.
    try {
        return await buildContextPackUnsafe(input);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not build the pack', e);
        return err('pack-write-failed');
    }
}

async function buildContextPackUnsafe(input: PackInput): Promise<Result<PreparedPack>> {
    const skipped: PreparedPack['skipped'] = [];
    const candidates: Array<{ role: string; note: PackNote }> = [{ role: 'Project note', note: input.project }];
    if (input.area) candidates.push({ role: 'Area note', note: input.area });
    for (const s of input.sources) candidates.push({ role: 'Context source', note: s });
    const included: Array<{ role: string; note: PackNote; text: string; hash: string }> = [];
    const seen = new Set<string>();
    // "In this pack" is what really ends up in it: start from the shareable notes, and while a note drops out because its links cannot be
    // checked, check again with the survivors (a link to a dropped note then says it is not in the pack). It settles within a few passes.
    const unique = candidates.filter((c) => (seen.has(c.note.path) ? false : (seen.add(c.note.path), true)));
    const shareable = unique.filter((c) => input.reasonNotShareable(c.note.path) === null);
    for (const c of unique) {
        const reason = input.reasonNotShareable(c.note.path);
        if (reason !== null) skipped.push({ path: c.note.path, reason });
    }
    let survivors = new Set(shareable.map((c) => c.note.path));
    let texts = new Map<string, string>();
    for (let pass = 0; pass < 4; pass++) {
        texts = new Map();
        const dropped: string[] = [];
        for (const c of shareable) {
            if (!survivors.has(c.note.path)) continue;
            const text = includedText(c.note, { ...input, inPack: survivors });
            // A note whose links cannot be checked against its cache is not packed; the preview says why.
            if (text.ok) texts.set(c.note.path, text.value); else dropped.push(c.note.path);
        }
        if (dropped.length === 0) break;
        for (const d of dropped) { survivors = new Set([...survivors].filter((p) => p !== d)); if (!skipped.some((s) => s.path === d)) skipped.push({ path: d, reason: 'links-unverified' }); }
    }
    for (const c of shareable) {
        const text = texts.get(c.note.path);
        if (text !== undefined && survivors.has(c.note.path)) included.push({ ...c, text, hash: await sha256(stripWorkspaceBlock(c.note.text)) });
    }
    // The project note is the pack's reason to exist: without it there is nothing to prepare.
    if (!included.some((i) => i.note.path === input.project.path)) {
        return err(skipped.some((s) => s.path === input.project.path && s.reason === 'links-unverified') ? 'pack-links-unverified' : 'ai-share-empty');
    }

    const projectIncluded = included.find((i) => i.note.path === input.project.path);
    const areaIncluded = input.area ? included.find((i) => i.note.path === input.area?.path) : undefined;
    const instructionInput = { aioId: input.aioId, projectName: input.projectName, projectNote: projectIncluded?.text ?? '', areaName: input.area?.path, areaNote: areaIncluded?.text };
    // What "copy instructions" puts on the clipboard carries the notes' text; inside the pack the notes follow in full, so they are not repeated.
    const instructions = buildWorkspaceInstructions(instructionInput);
    const packInstructions = buildWorkspaceInstructions({ ...instructionInput, notesFollow: true });
    const sources: PackSource[] = included.map((i) => ({ path: i.note.path, contentHash: i.hash }));
    const header = [
        '---',
        `aio-pack-vault: ${JSON.stringify(input.vaultId)}`,
        `aio-pack-project: ${input.aioId}`,
        `aio-pack-generator: ${PACK_GENERATOR_VERSION}`,
        `aio-pack-policy: ${input.sharePolicyRevision}`,
        '---',
    ].join('\n');
    const index = ['## Sources', ...sources.map((s) => `- ${s.path} (${s.contentHash.slice(0, 12)})`)].join('\n');
    const sections = included.map((i) => `## ${i.role}: ${i.note.path}\n\n${i.text}`);
    // The generation time is not part of the pack's bytes: a pack of unchanged sources must hash the same.
    const body = [header, '# Context pack', '## Instructions', packInstructions, index, ...sections].join('\n\n') + '\n';
    const bytes = byteLength(body);
    if (bytes > PACK_BUDGET_BYTES) return err('pack-over-budget');
    return ok({ instructions, text: body, bytes, digest: await sha256(body), sources, skipped, sharePolicyRevision: input.sharePolicyRevision, generatorVersion: PACK_GENERATOR_VERSION });
}

/** The notes that make a pack too big, largest first (for the refusal message). */
export function largestNotes(notes: readonly PackNote[], count = 5): Array<{ path: string; bytes: number }> {
    return notes.map((n) => ({ path: n.path, bytes: byteLength(n.text) })).sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

/** A preview approval is refused when anything it was made from has changed. */
export function verifyPrepared(prepared: PreparedPack, current: { sharePolicyRevision: string; hashes: ReadonlyMap<string, string> }): Result<true> {
    if (prepared.sharePolicyRevision !== current.sharePolicyRevision) return err('pack-preview-stale');
    for (const s of prepared.sources) if (current.hashes.get(s.path) !== s.contentHash) return err('pack-preview-stale');
    return ok(true);
}

export { sha256 as packSha256 };
