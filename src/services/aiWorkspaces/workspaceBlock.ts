/**
 * The workspace block: a plugin-owned section inside the project (or Area) note that lists its chat projects and the latest
 * pack. Written only through a reviewed edit; the text outside the markers is never touched. Pure.
 */
import { Result, ok, err } from '../../core/result';
import { findMarkedBlock, replaceMarkedBlock, type BlockMarkers } from '../../utils/ownedBlock';
import type { WorkspaceRecord } from './workspaceRecord';

export const WORKSPACE_MARKERS: BlockMarkers = {
    start: '<!-- aio:workspace -->',
    end: '<!-- /aio:workspace -->',
    nestedPrefixes: ['<!-- aio:workspace'],
};

const APP_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT' } as const;

/** Escape what would break a markdown link label or table-less line. */
const label = (s: string): string => s.replace(/[\r\n[\]]+/g, ' ').replace(/\s+/g, ' ').trim();

export function renderWorkspaceBlock(record: WorkspaceRecord, headings: { title: string; none: string; pack: string; released: string }): string {
    const lines = [WORKSPACE_MARKERS.start, `## ${headings.title}`];
    if (record.chats.length === 0) lines.push(`- ${headings.none}`);
    for (const chat of record.chats) lines.push(`- [${label(chat.name) || APP_LABEL[chat.app]}](${chat.url}) (${APP_LABEL[chat.app]})`);
    const last = record.packs[record.packs.length - 1];
    if (last) lines.push(`- ${headings.pack}: ${last.createdAt.slice(0, 10)}`);
    if (record.released) lines.push(`- ${headings.released}`);
    lines.push(WORKSPACE_MARKERS.end);
    return lines.join('\n');
}

/** The note text with the block added or replaced. A damaged block (duplicate or missing marker) is refused, never repaired. */
export function applyWorkspaceBlock(noteText: string, block: string): Result<string> {
    const res = replaceMarkedBlock(noteText, block, WORKSPACE_MARKERS);
    return res.ok ? res : err('workspace-block-conflict');
}

/** The block as it stands in the note: null = none yet, error = damaged. */
export function readWorkspaceBlock(noteText: string): Result<string | null> {
    const found = findMarkedBlock(noteText, WORKSPACE_MARKERS);
    if (!found.ok) return err('workspace-block-conflict');
    return ok(found.value ? found.value.text : null);
}

/** The note body without the workspace block: what a pack's staleness is judged on, so writing the block never makes a pack stale. */
export function stripWorkspaceBlock(noteText: string): string {
    const found = findMarkedBlock(noteText, WORKSPACE_MARKERS);
    if (!found.ok || !found.value) return noteText;
    return noteText.slice(0, found.value.start) + noteText.slice(found.value.end);
}
