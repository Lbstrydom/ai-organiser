/**
 * Adopting an existing note as a project (or an area / container): the pure edit. One insertion into the frontmatter, which
 * the caller shows as a reviewed edit. Nothing the user wrote is changed, and nothing is moved.
 */
import { Result, ok, err } from '../../core/result';
import { insertFrontmatterKeys, readFrontmatterRecord } from '../../utils/frontmatterKeys';
import { AIO_ID_KEY, AIO_ROLE_KEY, isAioId, newAioId, type ProjectRole } from './projectIndex';

export interface AdoptionPlan {
    text: string;
    aioId: string;
    /** The keys the edit adds, in order (for the preview sentence) */
    added: string[];
}

/** The id this adoption would give: the note's own valid id when it has one, else a new one. */
export function planAdoption(text: string, role: ProjectRole, makeId: () => string = newAioId): Result<AdoptionPlan> {
    const fm = readFrontmatterRecord(text);
    const existingId = fm && Object.hasOwn(fm, AIO_ID_KEY) ? fm[AIO_ID_KEY] : undefined;
    if (existingId !== undefined && !isAioId(existingId)) return err('project-id-invalid');
    const entries: Array<[string, string]> = [];
    const aioId = typeof existingId === 'string' ? existingId.trim().toLowerCase() : makeId();
    if (existingId === undefined) entries.push([AIO_ID_KEY, aioId]);
    const existingRole = fm?.[AIO_ROLE_KEY];
    const hasRole = !!fm && Object.hasOwn(fm, AIO_ROLE_KEY);
    // Any role other than the requested one (of another kind, or one the plugin does not know) is never silently changed.
    if (hasRole && existingRole !== role) return err('project-role-conflict');
    // The role already matches: only a missing id is added (a role without an identity is not an adopted project).
    if (!hasRole) {
        entries.push([AIO_ROLE_KEY, role]);
        // A project gets `status: active` only when the note has no status of its own.
        if (role === 'project' && !(fm && Object.hasOwn(fm, 'status'))) entries.push(['status', 'active']);
    }
    if (entries.length === 0) return err('project-already-adopted');
    const inserted = insertFrontmatterKeys(text, entries);
    if (!inserted.ok) return err(inserted.error === 'frontmatter-key-exists' ? 'project-role-conflict' : 'project-frontmatter-unreadable');
    return ok({ text: inserted.value.text, aioId, added: entries.map(([k]) => k) });
}
