/**
 * What may be shared with an AI app: an opt-in allow-list, default deny.
 *
 * `aiShareFolders` lists Area or project folders (empty = nothing is shared). A note is shareable only when the index scope
 * allows it (hidden paths, excluded and protected folders stay out) AND it sits inside an allow-list entry AND it is not in the
 * plugin's own pack folder. Packs always require the opt-in; the connector and the vault map follow the same function only when the
 * user turns on `aiShareRequireOptIn` (so existing connector users see no change).
 *
 * The share policy revision is a hash of everything that decides shareability, so an approval made under one policy cannot be
 * applied under another.
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { isInIndexScope, scopeConfigFromSettings } from '../agentIndex/agentIndexService';
import { sha256Hex } from '../attachmentDuplicateService';
import type { AIOrganiserSettings } from '../../core/settings';
import { isFeatureEnabled } from '../featureService';

/**
 * The opt-in for the connector and the vault map: on only while AI workspaces are on AND the person turned the opt-in on. Off, the
 * connector and the map serve exactly what they always did.
 */
export function shareOptInActive(settings: Pick<AIOrganiserSettings, 'featureFlags' | 'aiShareRequireOptIn'>): boolean {
    return isFeatureEnabled(settings as never, 'ai-workspaces') && settings.aiShareRequireOptIn === true;
}

/** At most this many allow-list entries. */
export const MAX_SHARE_FOLDERS = 40;

export type ShareSettings = Pick<AIOrganiserSettings, 'aiShareFolders' | 'aiShareRequireOptIn' | 'protectedFolders'
    | 'agentIndexIncludeFolders' | 'agentIndexExcludeFolders' | 'agentIndexIncludeAliases' | 'agentIndexIncludeHeadings'
    | 'agentIndexFrontmatterKeys' | 'agentIndexExportUnresolvedLinks'>;

/** Coerce stored data: trimmed, normalised, de-duplicated, capped. `[]` stays `[]` (nothing shared). */
export function normaliseShareFolders(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const path = normalisePath(entry.trim());
        if (path === '' || out.some((p) => p.toLowerCase() === path.toLowerCase())) continue;
        out.push(path);
        if (out.length >= MAX_SHARE_FOLDERS) break;
    }
    return out;
}

/** The entry of the allow-list that covers a path (the deepest), or null. */
export function shareFolderOf(path: string, settings: Pick<ShareSettings, 'aiShareFolders'>): string | null {
    const p = normalisePath(path);
    let best: string | null = null;
    for (const folder of normaliseShareFolders(settings.aiShareFolders)) {
        if (isInsideOrEqual(p, folder) && (best === null || folder.length > best.length)) best = folder;
    }
    return best;
}

/** True when a note may be included in a pack, an instructions copy or (with the opt-in) the connector and vault map. */
export function isAiShareable(path: string, settings: ShareSettings, packFolder?: string): boolean {
    if (shareFolderOf(path, settings) === null) return false;
    if (packFolder && packFolder.trim() !== '' && isInsideOrEqual(normalisePath(path), normalisePath(packFolder))) return false;
    return isInIndexScope(path, scopeConfigFromSettings(settings as never));
}

/** Why a note is not shareable, for the preview ("outside the allow-list", "protected", ...). */
export type NotShareableReason = 'outside-allow-list' | 'in-pack-folder' | 'kept-out';

export function notShareableReason(path: string, settings: ShareSettings, packFolder?: string): NotShareableReason | null {
    if (shareFolderOf(path, settings) === null) return 'outside-allow-list';
    if (packFolder && packFolder.trim() !== '' && isInsideOrEqual(normalisePath(path), normalisePath(packFolder))) return 'in-pack-folder';
    return isInIndexScope(path, scopeConfigFromSettings(settings as never)) ? null : 'kept-out';
}

/** A hash of everything that decides shareability: an approval made under one revision is refused under another. */
export async function sharePolicyRevision(settings: ShareSettings, packFolder = ''): Promise<string> {
    const canonical = JSON.stringify({
        share: [...normaliseShareFolders(settings.aiShareFolders)].sort(),
        optIn: settings.aiShareRequireOptIn === true,
        protected: [...(settings.protectedFolders ?? [])].map(normalisePath).sort(),
        include: [...settings.agentIndexIncludeFolders].map(normalisePath).sort(),
        exclude: [...settings.agentIndexExcludeFolders].map(normalisePath).sort(),
        pack: normalisePath(packFolder),
    });
    return sha256Hex(new TextEncoder().encode(canonical).buffer);
}
