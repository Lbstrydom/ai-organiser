/**
 * What a target IS, for the picker's "For this context" and the right-click section
 * (docs/plans/navigation-discoverability.md, decision 5).
 *
 * Deterministic: roles come from the path, the extension, frontmatter the plugin itself
 * writes, and the plugin's own settings. Never from a file name's wording, never from a model.
 * Pure: the caller passes the frontmatter it read from metadataCache.
 */
import { ACTIONS, type ActionDef } from './actionRegistry';
import type { Availability } from './actionAvailability';

/** Ordered most specific first; ranking uses this order. */
export const CONTEXT_ROLES = [
    'selection',
    'project', 'minutes', 'sweep-report', 'inbox',
    'pdf', 'audio', 'image', 'canvas',
    'markdown', 'folder', 'multi',
] as const;
export type ContextRole = typeof CONTEXT_ROLES[number];

const AUDIO = new Set(['mp3', 'm4a', 'wav', 'ogg', 'webm', 'flac', 'aac', 'mp4']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'avif']);

/** What the resolver is told about a target. */
export type RoleInput =
    | { kind: 'file'; path: string; extension: string; frontmatter?: Record<string, unknown> | null; hasSelection?: boolean }
    | { kind: 'folder'; path: string }
    | { kind: 'files'; count: number };

export interface RoleSettings {
    sweepInboxFolders: readonly string[];
    sweepReportPath: string;
}

const norm = (p: string): string => p.replace(/^\/+|\/+$/g, '');
const inFolder = (path: string, folder: string): boolean => {
    const f = norm(folder);
    return f !== '' && (path === f || path.startsWith(f + '/'));
};

export function resolveRoles(target: RoleInput, settings: RoleSettings): ContextRole[] {
    if (target.kind === 'folder') return ['folder'];
    if (target.kind === 'files') return target.count > 1 ? ['multi'] : [];
    const roles = new Set<ContextRole>();
    const ext = target.extension.toLowerCase();
    const path = norm(target.path);
    if (target.hasSelection) roles.add('selection');
    if (ext === 'md') {
        const fm = target.frontmatter ?? {};
        if (fm['aio-role'] === 'project') roles.add('project');
        // The plugin's own minutes frontmatter: both keys, never one alone.
        if (fm['type'] === 'meeting' && typeof fm['meeting_title'] === 'string') roles.add('minutes');
        if (norm(settings.sweepReportPath) === path) roles.add('sweep-report');
        if (settings.sweepInboxFolders.some((f) => inFolder(path, f))) roles.add('inbox');
        roles.add('markdown');
    } else if (ext === 'pdf') roles.add('pdf');
    else if (AUDIO.has(ext)) roles.add('audio');
    else if (IMAGE.has(ext)) roles.add('image');
    else if (ext === 'canvas') roles.add('canvas');
    return CONTEXT_ROLES.filter((r) => roles.has(r));
}

export interface RankedAction {
    readonly def: ActionDef;
    readonly score: readonly [number, number, number];
}

/**
 * Score ready actions against the roles: best (lowest) index of a matched role in the target's
 * role list, then the action's own index for that role in its `contexts`, then registry order.
 * The registry order is the stable tie-break, so a target always gets the same list.
 */
export function rankForContext(roles: readonly ContextRole[], defs: readonly ActionDef[] = ACTIONS): RankedAction[] {
    const out: RankedAction[] = [];
    defs.forEach((def, registryIndex) => {
        const contexts = def.contexts ?? [];
        let best: [number, number, number] | null = null;
        roles.forEach((role, roleIndex) => {
            const own = contexts.indexOf(role);
            if (own < 0) return;
            const score: [number, number, number] = [roleIndex, own, registryIndex];
            if (!best || score[0] < best[0] || (score[0] === best[0] && score[1] < best[1])) best = score;
        });
        if (best) out.push({ def, score: best });
    });
    return out.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2]);
}

/**
 * The one candidate pipeline both surfaces use: roles → availability once per action →
 * keep ready actions that accept this kind of target → rank → cap.
 */
export function candidatesFor(
    roles: readonly ContextRole[],
    availabilityOf: (def: ActionDef) => Availability,
    acceptsTarget: (def: ActionDef) => boolean,
    cap = 3,
): ActionDef[] {
    return rankForContext(roles)
        .filter(({ def }) => acceptsTarget(def) && availabilityOf(def).state === 'ready')
        .slice(0, cap)
        .map(({ def }) => def);
}
