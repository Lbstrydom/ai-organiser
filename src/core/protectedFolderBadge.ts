/**
 * Protected-folder shield (explorer badge): the pure half.
 *
 * Decides which file-explorer rows get the shield. Only the protected ROOTS are marked (the
 * folders the user listed); descendants are not, because the explorer's indent already shows
 * them nested under the shielded parent. Matching is the same case-insensitive, slash-normalised
 * comparison the write guards use (`protectedPaths.ts`), so the shield never disagrees with what
 * is enforced. No Obsidian imports: the DOM half lives in `ui/explorer/protectedFolderBadge.ts`.
 */
import { normalisePath, resolveProtectedFolders, type ProtectedSource } from './protectedPaths';

/** Class put on a `.nav-folder-title` whose folder is protected. */
export const PROTECTED_FOLDER_CLASS = 'ai-organiser-protected-folder';

/** Class of the shield element appended to a protected folder title. */
export const PROTECTED_SHIELD_CLASS = 'ai-organiser-protected-shield';

/** The explorer row that carries the folder path. */
export const EXPLORER_FOLDER_TITLE_SELECTOR = '.nav-folder-title[data-path]';

/** Lower-cased normalised keys of the protected roots. Empty list gives an empty set. */
export type BadgeIndex = ReadonlySet<string>;

export function buildBadgeIndex(source: ProtectedSource): BadgeIndex {
    return new Set(resolveProtectedFolders(source).map((f) => f.toLowerCase()));
}

/** True when the explorer row for `dataPath` is a protected root. The vault root never matches. */
export function isBadged(index: BadgeIndex, dataPath: string | null | undefined): boolean {
    if (index.size === 0 || !dataPath) return false;
    const key = normalisePath(dataPath).toLowerCase();
    return key !== '' && index.has(key);
}
