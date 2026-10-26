/**
 * PARA roots: the user's own folders for the inbox, projects, areas, reference and archive. One shared setting that the
 * project service, filing and reconcile read. This module only normalises and validates it (S1 builds nothing that moves).
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';

export type ParaKind = 'inbox' | 'projects' | 'areas' | 'reference' | 'archive';

export const PARA_KINDS: readonly ParaKind[] = ['inbox', 'projects', 'areas', 'reference', 'archive'];

export interface ParaRoot {
    path: string;
    kind: ParaKind;
    /** Filled when the root is paired with a Drive folder (a later slice) */
    driveRootId?: string;
}

/** At most this many roots (the setting is a short list, not a vault map). */
export const MAX_PARA_ROOTS = 12;

/** Coerce stored data into a clean list: unknown kinds, empty and duplicate paths are dropped. `[]` stays `[]`. */
export function normaliseParaRoots(raw: unknown): ParaRoot[] {
    if (!Array.isArray(raw)) return [];
    const out: ParaRoot[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const path = typeof e.path === 'string' ? normalisePath(e.path) : '';
        const kind = PARA_KINDS.find((k) => k === e.kind);
        if (path === '' || !kind) continue;
        if (out.some((r) => r.path.toLowerCase() === path.toLowerCase() && r.kind === kind)) continue;
        const driveRootId = typeof e.driveRootId === 'string' && e.driveRootId.trim() !== '' ? e.driveRootId.trim() : undefined;
        out.push(driveRootId ? { path, kind, driveRootId } : { path, kind });
        if (out.length >= MAX_PARA_ROOTS) break;
    }
    return out;
}

export type ParaRootProblem =
    | { code: 'root-missing'; path: string }
    | { code: 'root-protected'; path: string }
    | { code: 'root-output-folder'; path: string }
    | { code: 'inbox-mismatch'; path: string }
    | { code: 'root-overlap'; path: string; other: string };

export interface ParaRootContext {
    /** Folder paths that exist in the vault */
    existingFolders: ReadonlySet<string>;
    protectedFolders: readonly string[];
    /** Folders the plugin itself writes into */
    outputRoots: readonly string[];
    /** The capture/sweep inbox folders (inbox roots must equal them) */
    inboxFolders: readonly string[];
}

/**
 * Validate once, in the setup: each root exists, is not protected, is not a plugin output folder; inbox roots equal the
 * capture and sweep inbox folders; two roots of different kinds do not contain one another.
 */
export function validateParaRoots(roots: readonly ParaRoot[], ctx: ParaRootContext): ParaRootProblem[] {
    const problems: ParaRootProblem[] = [];
    const folders = new Set([...ctx.existingFolders].map((f) => normalisePath(f).toLowerCase()));
    const protectedList = ctx.protectedFolders.map(normalisePath).filter(Boolean);
    const outputs = ctx.outputRoots.map(normalisePath).filter(Boolean);
    const inbox = ctx.inboxFolders.map(normalisePath).filter(Boolean).map((p) => p.toLowerCase());
    for (const root of roots) {
        const path = normalisePath(root.path);
        if (!folders.has(path.toLowerCase())) problems.push({ code: 'root-missing', path });
        if (protectedList.some((p) => isInsideOrEqual(path, p) || isInsideOrEqual(p, path))) problems.push({ code: 'root-protected', path });
        if (outputs.some((o) => isInsideOrEqual(path, o) || isInsideOrEqual(o, path))) problems.push({ code: 'root-output-folder', path });
        if (root.kind === 'inbox' && !inbox.includes(path.toLowerCase())) problems.push({ code: 'inbox-mismatch', path });
    }
    for (let i = 0; i < roots.length; i++) {
        for (let j = i + 1; j < roots.length; j++) {
            if (roots[i].kind === roots[j].kind) continue;
            const a = normalisePath(roots[i].path);
            const b = normalisePath(roots[j].path);
            if (isInsideOrEqual(a, b) || isInsideOrEqual(b, a)) problems.push({ code: 'root-overlap', path: a, other: b });
        }
    }
    return problems;
}

/** The root a note path sits in (the deepest one), or null. */
export function rootOf(path: string, roots: readonly ParaRoot[]): ParaRoot | null {
    const p = normalisePath(path);
    let best: ParaRoot | null = null;
    for (const root of roots) {
        const r = normalisePath(root.path);
        if (isInsideOrEqual(p, r) && (!best || r.length > normalisePath(best.path).length)) best = root;
    }
    return best;
}
