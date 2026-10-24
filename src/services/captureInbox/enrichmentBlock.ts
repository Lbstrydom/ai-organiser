/**
 * The one plugin-owned block a capture note receives on Accept, and the fingerprint rule that makes
 * the plugin's own write invisible. The block uses the shared owned-block grammar (a marker fills its
 * line; a duplicate or nested marker is a conflict and nothing is written). Pure.
 */
import { Result, ok, err } from '../../core/result';
import { findMarkedBlock, replaceMarkedBlock, type BlockMarkers } from '../../utils/ownedBlock';
import { sha256Hex } from '../attachmentDuplicateService';
import { setCaptureKeys, stripCaptureKeys, readCaptureId } from './frontmatterKey';
import {
    CAPTURE_BLOCK_END,
    CAPTURE_BLOCK_START,
    CAPTURE_STATUS_ACCEPTED,
    type CaptureAttachmentRef,
    type CaptureProposal,
    type CaptureSource,
    type InsertedSpans,
} from './captureTypes';

export const CAPTURE_MARKERS: BlockMarkers = { start: CAPTURE_BLOCK_START, end: CAPTURE_BLOCK_END };

const SOURCE_LABEL: Record<CaptureSource, string> = {
    'note-text': 'note text',
    transcript: 'transcript',
    digitised: 'digitised text',
    mixed: 'text, transcript and digitised text',
};

/** Machine text must not be able to forge or close the owned block. */
function neutralise(text: string): string {
    return text.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
}

/**
 * Machine text lands in a note that the user, the sweep and the tag index all read, so structure it could
 * open is defused: a code fence (it would hide the end marker), a checkbox (a task) and a #tag.
 */
function defuseMachineText(text: string): string {
    return neutralise(text)
        .split('\n')
        .map((line) =>
            line
                .replace(/^(\s*)(`{3,}|~{3,})/, '$1\\$2')
                .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([^\]]?)\]/, '$1\\[$2\\]')
                .replace(/(^|\s)#(?=[\p{L}\p{N}_])/gu, '$1\\#')
                .replaceAll('[[', '\\[['),
        )
        .join('\n');
}

export interface BlockContent {
    /** The machine-produced text only (transcript / digitised). Text the user wrote is never copied in. */
    machineText: string;
    proposal: CaptureProposal;
    source: CaptureSource;
}

/** Plain lines only: no checkboxes, no `#tags`, no `[[links]]` or embeds, so nothing is indexed, swept or pulled in twice. */
export function renderCaptureBlock(content: BlockContent): string {
    const parts: string[] = [CAPTURE_BLOCK_START, `Capture inbox: ${SOURCE_LABEL[content.source]}.`];
    const text = content.machineText.trim();
    if (text) parts.push('', defuseMachineText(text));
    const meta: string[] = [];
    const line = (s: string): string => defuseMachineText(s.replace(/\s+/g, ' ').trim());
    if (content.proposal.title) meta.push(`Proposed title: ${line(content.proposal.title)}`);
    if (content.proposal.tags.length > 0) meta.push(`Proposed tags: ${content.proposal.tags.map(line).join(', ')}`);
    if (content.proposal.folder) meta.push(`Proposed folder: ${line(content.proposal.folder)}`);
    if (meta.length > 0) parts.push('', ...meta);
    parts.push(CAPTURE_BLOCK_END);
    return parts.join('\n');
}

export type FoundBlock = { text: string; start: number; end: number };

export function findCaptureBlock(text: string): Result<FoundBlock | null> {
    return findMarkedBlock(text, CAPTURE_MARKERS);
}

export interface AcceptWrite {
    text: string;
    /** What was added, or null when nothing was (this capture's block was already there): keep the journal's record */
    inserted: InsertedSpans | null;
}

/**
 * The Accept write as a pure function of the current note. Refuses (`capture-changed`) when a block
 * or the keys already exist for a different capture, and is a no-op when this capture's block is
 * already there. The returned `inserted` records exactly what was added so it can be stripped.
 */
export function applyAccept(current: string, id: string, content: BlockContent): Result<AcceptWrite> {
    const existing = findCaptureBlock(current);
    if (!existing.ok) return err('capture-marker-conflict');
    if (existing.value !== null) {
        return readCaptureId(current) === id ? ok({ text: current, inserted: null }) : err('capture-changed');
    }
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const block = renderCaptureBlock(content).replaceAll('\n', eol);
    const withBlock = replaceMarkedBlock(current, block, CAPTURE_MARKERS);
    if (!withBlock.ok) return err('capture-marker-conflict');
    // `replaceMarkedBlock` adds only whitespace separators and a trailing newline.
    const withKeys = setCaptureKeys(withBlock.value, { id, status: CAPTURE_STATUS_ACCEPTED });
    if (!withKeys.ok) return err('capture-frontmatter-unreadable');
    // The block just written must be findable again, or the fingerprint could never ignore it.
    const written = findCaptureBlock(withKeys.value.text);
    if (!written.ok || written.value === null) return err('capture-marker-conflict');
    return ok({
        text: withKeys.value.text,
        inserted: { separatorAdded: withBlock.value.length > current.length + block.length + 1, frontmatterCreated: withKeys.value.frontmatterCreated },
    });
}

/** Remove the plugin's insertions (block and keys). Whitespace at the tail is normalised by the fingerprint, not here. */
export function stripCaptureInsertions(text: string, inserted: Pick<InsertedSpans, 'frontmatterCreated'>): string {
    let out = text;
    const block = findCaptureBlock(out);
    if (block.ok && block.value) out = out.slice(0, block.value.start) + out.slice(block.value.end);
    return stripCaptureKeys(out, { frontmatterCreated: inserted.frontmatterCreated });
}

/** Line endings and trailing whitespace carry no meaning for the fingerprint. */
export function normaliseForFingerprint(text: string): string {
    return text.replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

/**
 * sha256 over the note with the plugin's insertions removed and the tail normalised, plus the sorted
 * `path:size` of every attachment. The plugin's own write therefore never changes it; any edit by the
 * user, or a swapped attachment, does.
 */
export async function computeFingerprint(
    text: string,
    attachments: readonly Pick<CaptureAttachmentRef, 'path' | 'size'>[],
    inserted: Pick<InsertedSpans, 'frontmatterCreated'> = { frontmatterCreated: false },
): Promise<string> {
    const base = normaliseForFingerprint(stripCaptureInsertions(text, inserted));
    const att = attachments.map((a) => `${a.path}:${a.size}`).sort();
    return sha256Hex(new TextEncoder().encode(JSON.stringify({ t: base, a: att })).buffer);
}
