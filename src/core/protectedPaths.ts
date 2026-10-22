/**
 * Protected folders: the single source of truth for "the plugin must never modify,
 * rename, trash or create anything here".
 *
 * Everything in this module is pure except the tiny `activeProtection` registry at
 * the bottom, which exists only so seams that do not receive settings (the tag and
 * frontmatter writers) can ask the same question. An empty list means no protection
 * and every function answers "writable" without inspecting the path, so with the
 * feature unused the plugin's behaviour is byte-identical.
 *
 * Matching is case-insensitive, slash-normalised and prefix-safe: `A/B` protects
 * `A/B` and `A/B/c.md` but not `A/BC`. A protected folder that no longer exists
 * still blocks creates at its path (enforcement is string-based and fails closed).
 */
import { Result, ok, err } from './result';

export type WriteOp = 'create' | 'modify' | 'delete' | 'rename';

/** One path an operation touches. A folder operation covers every descendant. */
export interface WriteTarget {
    path: string;
    folder?: boolean;
}

/** Anything that carries a protected folder list: a plain array or the settings object. */
export type ProtectedSource = readonly string[] | { protectedFolders?: readonly string[] | null } | null | undefined;

/** Stable error code returned by every guard. */
export const PROTECTED_PATH_ERROR = 'protected-path';

/**
 * Normalise a vault path for comparison: forward slashes, no leading or trailing slash, no `.`
 * segments, and `..` resolved (`A/../B` is `B`; a `..` at the root cannot climb out of the vault).
 */
export function normalisePath(path: string): string {
    const out: string[] = [];
    for (const seg of path.replaceAll('\\', '/').split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            out.pop();
            continue;
        }
        out.push(seg);
    }
    return out.join('/');
}

function key(path: string): string {
    return normalisePath(path).toLowerCase();
}

/** Resolve the list from either shape. Entries are normalised, de-duplicated and non-empty. */
export function resolveProtectedFolders(source: ProtectedSource): string[] {
    const raw = Array.isArray(source)
        ? (source as readonly string[])
        : ((source as { protectedFolders?: readonly string[] | null } | null | undefined)?.protectedFolders ?? []);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const norm = normalisePath(entry);
        if (!norm) continue; // an empty entry would protect the whole vault by accident
        const k = norm.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(norm);
    }
    return out;
}

/** True when `child` equals `ancestor` or sits inside it (prefix-safe, case-insensitive). */
export function isInsideOrEqual(child: string, ancestor: string): boolean {
    const c = key(child);
    const a = key(ancestor);
    return c === a || c.startsWith(a + '/');
}

/** True when the single path is inside (or equal to) a protected folder. */
export function isProtectedPath(source: ProtectedSource, path: string): boolean {
    const folders = resolveProtectedFolders(source);
    if (folders.length === 0) return false;
    return folders.some((f) => isInsideOrEqual(path, f));
}

/**
 * True when the target is protected. A folder target is also protected when it contains
 * a protected folder, because moving or deleting the parent would move or delete it.
 */
function isTargetProtected(folders: readonly string[], target: WriteTarget): boolean {
    if (folders.some((f) => isInsideOrEqual(target.path, f))) return true;
    if (target.folder) {
        return folders.some((f) => isInsideOrEqual(f, target.path));
    }
    return false;
}

/**
 * Decide whether an operation may proceed. For a rename or move pass BOTH the source and the
 * destination. Returns `Result.err('protected-path')` when any target is protected.
 */
export function assertWritable(
    source: ProtectedSource,
    _op: WriteOp,
    targets: string | WriteTarget | ReadonlyArray<string | WriteTarget>,
): Result<void> {
    const folders = resolveProtectedFolders(source);
    if (folders.length === 0) return ok(undefined);
    const list = Array.isArray(targets) ? (targets as ReadonlyArray<string | WriteTarget>) : [targets as string | WriteTarget];
    for (const t of list) {
        const target: WriteTarget = typeof t === 'string' ? { path: t } : t;
        if (isTargetProtected(folders, target)) return err(PROTECTED_PATH_ERROR);
    }
    return ok(undefined);
}

/**
 * Keep protection attached to the folder when Obsidian renames or moves it. Entries equal to
 * or inside the old path follow it to the new path. Returns the new list and whether it changed.
 */
export function rewriteOnRename(
    list: readonly string[],
    oldPath: string,
    newPath: string,
): { list: string[]; changed: boolean } {
    // Compare segment by segment and rewrite by segment count, never by string offset: lower-casing
    // can change a string's length (some characters expand), so an offset taken from the lower-cased
    // key is not a valid offset into the original text.
    const oldSegs = normalisePath(oldPath).split('/').filter(Boolean).map((s) => s.toLowerCase());
    const newNorm = normalisePath(newPath);
    let changed = false;
    const next = list.map((entry) => {
        const segs = normalisePath(entry).split('/').filter(Boolean);
        if (oldSegs.length === 0 || segs.length < oldSegs.length) return entry;
        for (let i = 0; i < oldSegs.length; i++) {
            if (segs[i].toLowerCase() !== oldSegs[i]) return entry;
        }
        changed = true;
        return [newNorm, ...segs.slice(oldSegs.length)].filter(Boolean).join('/');
    });
    return { list: next, changed };
}

/** One plugin output root and the protected folder it collides with. */
export interface OutputRootConflict {
    label: string;
    path: string;
    protectedFolder: string;
}

/**
 * Output roots (chat, export, newsletter, recordings, agent index, sweep report, …) must be
 * disjoint from protected folders, in both directions. An empty root means "the vault root"
 * and collides with any protected folder.
 */
export function findOutputRootConflicts(
    source: ProtectedSource,
    roots: ReadonlyArray<{ label: string; path: string }>,
): OutputRootConflict[] {
    const folders = resolveProtectedFolders(source);
    const conflicts: OutputRootConflict[] = [];
    if (folders.length === 0) return conflicts;
    for (const root of roots) {
        const rootNorm = normalisePath(root.path);
        for (const f of folders) {
            const collides = rootNorm === '' || isInsideOrEqual(rootNorm, f) || isInsideOrEqual(f, rootNorm);
            if (collides) {
                conflicts.push({ label: root.label, path: rootNorm, protectedFolder: f });
                break;
            }
        }
    }
    return conflicts;
}

// ── Active registry ─────────────────────────────────────────────────────────────────────────
// Seams that never receive settings (tag and frontmatter writers) read the live list from here.
// `main.ts` installs the getter on load. Unset (tests, first load) means "no protection".

let activeGetter: (() => ProtectedSource) | null = null;

/** Install (or clear, with `null`) the function that returns the live protected list. */
export function setActiveProtection(getter: (() => ProtectedSource) | null): void {
    activeGetter = getter;
}

/** Guard for seams without settings access. */
export function assertWritableActive(
    op: WriteOp,
    targets: string | WriteTarget | ReadonlyArray<string | WriteTarget>,
): Result<void> {
    return assertWritable(activeGetter ? activeGetter() : null, op, targets);
}

/** True when the active list protects the path. */
export function isProtectedActive(path: string): boolean {
    return isProtectedPath(activeGetter ? activeGetter() : null, path);
}

/** True when at least one folder is protected right now. Guards that cannot establish their target use this to fail closed. */
export function hasActiveProtection(): boolean {
    return resolveProtectedFolders(activeGetter ? activeGetter() : null).length > 0;
}
