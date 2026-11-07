/**
 * Adopting an existing note as a project (or an area / container): the pure edit. One insertion into the frontmatter, which
 * the caller shows as a reviewed edit. Nothing the user wrote is changed, and nothing is moved. The one value that may be
 * replaced is the plugin's own processing mark in `status` (`processed` / `pending` / `error`): it is the AI's, not a
 * project status, so a project adopted with it gets `status: active` in the same edit.
 */
import { Result, ok, err } from '../../core/result';
import { insertFrontmatterKeys, readFrontmatterRecord, replaceFrontmatterScalar } from '../../utils/frontmatterKeys';
import { AIO_ID_KEY, AIO_ROLE_KEY, isAiProcessingMark, isAioId, newAioId, type ProjectRole } from './projectIndex';

export interface AdoptionPlan {
    text: string;
    aioId: string;
    /** The keys the edit adds, in order (for the preview sentence) */
    added: string[];
    /** The processing mark the edit replaced with `status: active` (`processed` / `pending` / `error`), when it did */
    replacedMark?: string;
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
    let base = text;
    let replacedMark: string | undefined;
    if (!hasRole) {
        entries.push([AIO_ROLE_KEY, role]);
        const hasStatus = !!fm && Object.hasOwn(fm, 'status');
        // A project gets `status: active` when the note has no status of its own, or when its status is only the AI's
        // processing mark. A mark written in a shape that cannot be replaced line-for-line (a list, a block) is left as is.
        if (role === 'project' && !hasStatus) entries.push(['status', 'active']);
        else if (role === 'project' && isAiProcessingMark(fm?.status)) {
            const replaced = replaceFrontmatterScalar(text, 'status', isAiProcessingMark, 'active');
            if (replaced.ok) { base = replaced.value; replacedMark = String(fm?.status).trim(); }
        }
    }
    if (entries.length === 0) return err('project-already-adopted');
    const inserted = insertFrontmatterKeys(base, entries);
    if (!inserted.ok) return err(inserted.error === 'frontmatter-key-exists' ? 'project-role-conflict' : 'project-frontmatter-unreadable');
    return ok({ text: inserted.value.text, aioId, added: entries.map(([k]) => k), ...(replacedMark ? { replacedMark } : {}) });
}
