/**
 * What an action runs against (docs/plans/navigation-discoverability.md, decision 9).
 *
 * `active` is the palette's behaviour: the command reads the workspace itself. The other kinds
 * are explicit targets handed over by a menu or a scoped picker; they are resolved and run in
 * Phase 4 (`src/services/actionRunner.ts`). Types and one pure helper only.
 */
import type { TFile, TFolder } from 'obsidian';

export type ActionTarget =
    | { readonly kind: 'active' }
    | { readonly kind: 'file'; readonly file: TFile }
    | { readonly kind: 'folder'; readonly folder: TFolder }
    | { readonly kind: 'files'; readonly files: readonly TFile[] }
    | { readonly kind: 'selection'; readonly file: TFile; readonly text: string; readonly from: number; readonly to: number };

export type ActionTargetKind = ActionTarget['kind'];

/** The only target shapes that survive a reload: a path to one file or one folder. */
export interface StoredTarget {
    readonly kind: 'file' | 'folder';
    readonly path: string;
}

/**
 * The part of a target that can be stored and rebuilt after a reload, or null. A selection,
 * a multi-file pick and the active context are never stored: they cannot be rebuilt safely,
 * so an action resumed from one of them asks the user again.
 */
export function toStoredTarget(target: ActionTarget): StoredTarget | null {
    if (target.kind === 'file') return { kind: 'file', path: target.file.path };
    if (target.kind === 'folder') return { kind: 'folder', path: target.folder.path };
    return null;
}

/** True when a stored value has the stored-target shape (used when reading settings). */
export function isStoredTarget(value: unknown): value is StoredTarget {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (v.kind === 'file' || v.kind === 'folder') && typeof v.path === 'string' && v.path.length > 0;
}
