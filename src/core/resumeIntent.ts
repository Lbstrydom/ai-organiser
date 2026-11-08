/**
 * The one thing AI Organiser remembers across the reload that turns a feature on: what the
 * user had chosen, so it can be offered (never run) once the plugin is back
 * (docs/plans/navigation-discoverability.md, decision 3).
 *
 * Versioned. A value this code does not recognise is dropped by `migrateOldSettings`.
 * Selections and multi-file picks are never stored (see `toStoredTarget`).
 */
import { isStoredTarget, type StoredTarget } from './actionTarget';

export type ResumeIntent =
    | { readonly v: 1; readonly kind: 'action'; readonly commandId: string; readonly target?: StoredTarget; readonly createdAt: number }
    | { readonly v: 1; readonly kind: 'job'; readonly jobId: string; readonly createdAt: number };

/** An intent older than this is discarded on load: the moment has passed. */
export const RESUME_MAX_AGE_MS = 10 * 60 * 1000;

export function isResumeIntent(value: unknown): value is ResumeIntent {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (v.v !== 1 || typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return false;
    if (v.kind === 'action') {
        return typeof v.commandId === 'string' && v.commandId.length > 0
            && (v.target === undefined || isStoredTarget(v.target));
    }
    if (v.kind === 'job') return typeof v.jobId === 'string' && v.jobId.length > 0;
    return false;
}
