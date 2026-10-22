/**
 * Canvas write port: the only code that edits an EXISTING `.canvas` file.
 *
 * Used by the Drive offload to turn a canvas `file` node into a `link` node that points at the
 * Drive copy. The contract mirrors `noteWritePort`:
 *  1. parse with the same JSON Canvas 1.0 rules as the attachment scan; refuse on any failure;
 *  2. `assertWritable` on the canvas path (protected folders);
 *  3. change only the targeted nodes: a `file` node becomes `{ type: 'link', url }` and keeps its
 *     id, position, size and colour, so edges to it keep working; every other node and edge is
 *     preserved exactly;
 *  4. commit inside `vault.process` and refuse unless the current text is still the baseline the
 *     caller captured (`referrer-changed`);
 *  5. serialise with the same stable formatting as `serializeCanvas`.
 */
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { assertWritable, type ProtectedSource } from '../../core/protectedPaths';
import { logger } from '../../utils/logger';
import { serializeCanvas } from './canvasUtils';
import type { CanvasData } from './types';

export interface CanvasLinkEdit {
    nodeId: string;
    url: string;
}

const KEEP = ['id', 'x', 'y', 'width', 'height', 'color'] as const;

/** Pure transform of canvas text. `err('canvas-unreadable')` or `err('node-missing')`. */
export function transformCanvas(text: string, edits: readonly CanvasLinkEdit[]): Result<string> {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return err('canvas-unreadable');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return err('canvas-unreadable');
    const root = data as { nodes?: unknown };
    if (!Array.isArray(root.nodes)) return err('canvas-unreadable');
    const byId = new Map(edits.map((e) => [e.nodeId, e.url]));
    const done = new Set<string>();
    root.nodes = root.nodes.map((node: unknown) => {
        if (!node || typeof node !== 'object') return node;
        const n = node as Record<string, unknown>;
        const url = typeof n.id === 'string' ? byId.get(n.id) : undefined;
        if (url === undefined || n.type !== 'file') return node;
        done.add(n.id as string);
        const next: Record<string, unknown> = {};
        for (const key of KEEP) if (n[key] !== undefined) next[key] = n[key];
        next.type = 'link';
        next.url = url;
        return next;
    });
    for (const e of edits) if (!done.has(e.nodeId)) return err('node-missing');
    return ok(serializeCanvas(root as CanvasData));
}

/**
 * Rewrite the given file nodes of an existing canvas. `baseline` is the text the caller planned
 * against; if the canvas has changed since, nothing is written.
 */
export async function rewriteCanvasNodes(
    app: App,
    path: string,
    edits: readonly CanvasLinkEdit[],
    baseline: string,
    protectedFolders: ProtectedSource,
): Promise<Result<void>> {
    const allowed = assertWritable(protectedFolders, 'modify', path);
    if (!allowed.ok) return err(allowed.error);
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'canvas') return err('target-missing');
    try {
        let failure: string | null = null;
        await app.vault.process(file, (current) => {
            if (current !== baseline) { failure = 'referrer-changed'; return current; }
            const next = transformCanvas(current, edits);
            if (!next.ok) { failure = next.error; return current; }
            return next.value;
        });
        return failure ? err(failure) : ok(undefined);
    } catch (e) {
        logger.error('Offload', 'Canvas write failed', e);
        return err('write-failed');
    }
}
