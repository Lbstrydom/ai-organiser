/**
 * The context pack: one markdown file holding the instructions, the project note, the Area note and the chosen context
 * sources, each with its path and content hash. Only notes the share policy allows are included; a link to a note that is not
 * shareable reads `[not shared]`, and attachments are never included. Pure: the caller supplies the note texts and the policy.
 *
 * A prepared pack is bound to a snapshot: it carries the hash of every source and the share-policy revision, and `verifyPrepared`
 * refuses to write it when either has changed since the preview.
 */
import { Result, ok, err } from '../../core/result';
import { toModelText } from '../../utils/excalidrawContent';
import { bodyWithoutOwned, buildWorkspaceInstructions } from './workspaceInstructions';
import { stripWorkspaceBlock } from './workspaceBlock';

/** Same budget as the vault map. */
export const PACK_BUDGET_BYTES = 400 * 1024;
export const PACK_GENERATOR_VERSION = 1;

export interface PackNote {
    path: string;
    text: string;
}

export type SkipReason = 'outside-allow-list' | 'in-pack-folder' | 'kept-out' | 'missing';

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
    /** Resolve a `[[link]]` written in `from` to a vault path, or null when it does not resolve */
    resolveLink: (link: string, from: string) => string | null;
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

const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|pdf|docx?|pptx?|xlsx?|mp3|m4a|wav|mp4|mov|zip)$/i;

/** Links and embeds in an included note: attachments are not included; a note the policy does not allow reads `[not shared]`. */
export function neutraliseLinks(text: string, from: string, input: Pick<PackInput, 'reasonNotShareable' | 'resolveLink'>): string {
    return neutraliseWikilinks(neutraliseMarkdownLinks(text, from, input), from, input);
}

/**
 * `[text](path)` and `![alt](path)` to vault paths: the same rules as wikilinks. Web and mail addresses and in-page anchors are left as written.
 * Scanned, not matched by a pattern: the destination is read to its BALANCED closing parenthesis at any depth. A destination that
 * never closes on its line is treated as private (fail closed) and the rest of the line is replaced.
 */
function neutraliseMarkdownLinks(text: string, from: string, input: Pick<PackInput, 'reasonNotShareable' | 'resolveLink'>): string {
    const start = /(!?)\[([^\]\n]*)\]\(/g;
    let out = '';
    let last = 0;
    for (let m = start.exec(text); m !== null; m = start.exec(text)) {
        const bang = m[1];
        const label = m[2];
        const open = m.index + m[0].length;
        let depth = 1;
        let i = open;
        for (; i < text.length && text[i] !== '\n'; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')' && --depth === 0) break;
        }
        const closed = depth === 0;
        const end = closed ? i + 1 : (text.indexOf('\n', open) === -1 ? text.length : text.indexOf('\n', open));
        out += text.slice(last, m.index);
        last = end;
        start.lastIndex = end;
        const whole = text.slice(m.index, end);
        const placeholder = bang ? '[not shared]' : label + ' [not shared]';
        if (!closed) { out += placeholder; continue; }
        const inner = text.slice(open, i).trim();
        const rawTarget = inner.startsWith('<') ? inner.slice(1, inner.indexOf('>') === -1 ? undefined : inner.indexOf('>')) : inner.split(/\s/)[0];
        if (rawTarget === '' || rawTarget.startsWith('#') || /^(https?:|mailto:)/i.test(rawTarget)) { out += whole; continue; }
        let path = rawTarget;
        try { path = decodeURIComponent(rawTarget); } catch { /* keep as written */ }
        path = path.replace(/#.*$/, '');
        if (ATTACHMENT_EXT.test(path)) { out += bang ? '[attachment not included]' : label + ' [attachment not included]'; continue; }
        const resolved = input.resolveLink(path, from);
        if (resolved === null) { out += placeholder; continue; }
        if (ATTACHMENT_EXT.test(resolved)) { out += '[attachment not included]'; continue; }
        out += input.reasonNotShareable(resolved) === null ? whole : placeholder;
    }
    return out + text.slice(last);
}

function neutraliseWikilinks(text: string, from: string, input: Pick<PackInput, 'reasonNotShareable' | 'resolveLink'>): string {
    return text.replace(/(!?)\[\[([^\]\n|#]+)(#[^\]\n|]*)?(\|([^\]\n]*))?\]\]/g, (whole, bang: string, target: string, _heading: string | undefined, _alias: string | undefined, alias: string | undefined) => {
        if (ATTACHMENT_EXT.test(target.trim())) return bang ? '[attachment not included]' : `${alias ?? target.trim()} [attachment not included]`;
        const resolved = input.resolveLink(target.trim(), from);
        if (resolved === null) return bang ? '[not shared]' : whole;
        if (ATTACHMENT_EXT.test(resolved)) return '[attachment not included]';
        return input.reasonNotShareable(resolved) === null ? (bang ? `${alias ?? target.trim()}` : whole) : (bang ? '[not shared]' : `${alias ?? target.trim()} [not shared]`);
    });
}

/** Text of one included note: drawing blobs dropped, plugin-owned blocks left out, links neutralised. */
function includedText(note: PackNote, input: PackInput): string {
    const model = toModelText(note.text, note.path);
    return neutraliseLinks(bodyWithoutOwned(model), note.path, input);
}

export async function buildContextPack(input: PackInput): Promise<Result<PreparedPack>> {
    const skipped: PreparedPack['skipped'] = [];
    const candidates: Array<{ role: string; note: PackNote }> = [{ role: 'Project note', note: input.project }];
    if (input.area) candidates.push({ role: 'Area note', note: input.area });
    for (const s of input.sources) candidates.push({ role: 'Context source', note: s });
    const included: Array<{ role: string; note: PackNote; text: string; hash: string }> = [];
    const seen = new Set<string>();
    for (const c of candidates) {
        if (seen.has(c.note.path)) continue;
        seen.add(c.note.path);
        const reason = input.reasonNotShareable(c.note.path);
        if (reason !== null) { skipped.push({ path: c.note.path, reason }); continue; }
        included.push({ ...c, text: includedText(c.note, input), hash: await sha256(stripWorkspaceBlock(c.note.text)) });
    }
    // The project note is the pack's reason to exist: without it there is nothing to prepare.
    if (!included.some((i) => i.note.path === input.project.path)) return err('ai-share-empty');

    const projectIncluded = included.find((i) => i.note.path === input.project.path);
    const areaIncluded = input.area ? included.find((i) => i.note.path === input.area?.path) : undefined;
    const instructions = buildWorkspaceInstructions({
        aioId: input.aioId,
        projectName: input.projectName,
        projectNote: projectIncluded?.text ?? '',
        areaName: input.area?.path,
        areaNote: areaIncluded?.text,
    });
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
    const body = [header, '# Context pack', '## Instructions', instructions, index, ...sections].join('\n\n') + '\n';
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
