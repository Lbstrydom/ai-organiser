/**
 * Which existing review an imported hand-back can go to. Pure over the injected project index and protected-folder check.
 *
 * Only a Project ID that names exactly one adopted, non-duplicated project whose note is not protected is routed; anything
 * else fails closed (the copy stays in the inbox, nothing is applied). The importer never applies a hand-back: routing only
 * offers the existing reviewed hand-back window for the copy.
 */
import { looksLikeHandback, parseHandoff } from '../aiWorkspaces/handoffParser';
import type { ProjectIndex } from '../projects/projectIndex';

export type HandoffRoute =
    | { kind: 'not-handback' }
    | { kind: 'review-off' }
    | { kind: 'no-id' }
    | { kind: 'unknown-project'; projectId: string }
    | { kind: 'protected'; projectId: string; notePath: string }
    | { kind: 'routed'; projectId: string; notePath: string };

export interface RouteContext {
    /** The hand-back review exists (AI workspaces and capture inbox both on) */
    reviewActive: boolean;
    /** The project index, or null when the project service is unavailable (treated as no project known) */
    index: Pick<ProjectIndex, 'projects' | 'duplicates'> | null;
    isProtected: (path: string) => boolean;
    contexts: readonly string[];
}

export function classifyHandoff(text: string, ctx: RouteContext): HandoffRoute {
    if (!looksLikeHandback(text)) return { kind: 'not-handback' };
    if (!ctx.reviewActive) return { kind: 'review-off' };
    const projectId = parseHandoff(text, ctx.contexts).projectId;
    if (projectId === undefined || projectId === '') return { kind: 'no-id' };
    const index = ctx.index;
    // The parser gives the id in lower case; a project's id is compared the same way.
    if (!index || [...index.duplicates.keys()].some((k) => k.toLowerCase() === projectId)) return { kind: 'unknown-project', projectId };
    const matches = index.projects.filter((p) => p.aioId.toLowerCase() === projectId);
    if (matches.length !== 1) return { kind: 'unknown-project', projectId };
    const notePath = matches[0].notePath;
    if (ctx.isProtected(notePath)) return { kind: 'protected', projectId, notePath };
    return { kind: 'routed', projectId, notePath };
}
