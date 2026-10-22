/**
 * The inbox sweep's exclusion guard. Pure and FAIL-CLOSED: it runs before any model call, on the
 * full captured snapshot (before any truncation), and is the only code that can produce a
 * `GuardedSnapshot`. Extraction accepts nothing else, so excluded or unchecked text cannot reach
 * the provider by construction.
 *
 * A note is excluded when ANY of these holds:
 *  - its path is inside an excluded folder or any protected folder;
 *  - it carries an excluded tag (a nested tag is excluded with its parent: `work` excludes `work/x`);
 *  - a frontmatter property matches an excluded `key: value` pair;
 *  - its text contains an excluded term (plain, case-insensitive);
 *  - anything is unknown: the text is not a string, the path is empty, the frontmatter cannot be
 *    parsed, or the note is larger than the cap.
 *
 * The guard is data-driven: the plugin ships no built-in company, folder or term.
 */
import { isInsideOrEqual, normalisePath, resolveProtectedFolders, type ProtectedSource } from '../../core/protectedPaths';
import { sha256Hex } from '../attachmentDuplicateService';
import { normaliseTag, parseSnapshotMetadata, type NoteSnapshot } from './noteSnapshot';

export interface SweepPolicy {
    excludedFolders: readonly string[];
    excludedTags: readonly string[];
    /** `key: value` pairs, for example `client: acme` */
    excludedProperties: readonly string[];
    excludedTerms: readonly string[];
    protectedFolders: ProtectedSource;
    /** Notes longer than this are excluded rather than truncated silently */
    maxNoteChars: number;
}

export type ExclusionReason = 'folder' | 'protected' | 'tag' | 'property' | 'term' | 'unreadable' | 'too-large' | 'unknown';

declare const guardedBrand: unique symbol;
/** A snapshot the guard has judged allowed. Only `guardSnapshot` returns one. */
export type GuardedSnapshot = NoteSnapshot & { readonly [guardedBrand]: true };

export type GuardResult =
    | { allowed: true; snapshot: GuardedSnapshot }
    | { allowed: false; reason: ExclusionReason };

/** A stable fingerprint of everything that decides exclusion. Changes when any setting that matters changes. */
export async function policyRevisionOf(policy: SweepPolicy): Promise<string> {
    const norm = (list: readonly string[]): string[] => list.map((s) => s.trim().toLowerCase()).filter(Boolean).sort();
    const body = JSON.stringify({
        f: norm(policy.excludedFolders.map(normalisePath)),
        t: norm(policy.excludedTags.map(normaliseTag)),
        p: norm(policy.excludedProperties),
        w: norm(policy.excludedTerms),
        x: norm(resolveProtectedFolders(policy.protectedFolders)),
        m: policy.maxNoteChars,
    });
    return sha256Hex(new TextEncoder().encode(body).buffer);
}

function parseProperty(entry: string): { key: string; value: string } | null {
    const i = entry.indexOf(':');
    if (i <= 0) return null;
    const key = entry.slice(0, i).trim().toLowerCase();
    const value = entry.slice(i + 1).trim().toLowerCase();
    return key && value ? { key, value } : null;
}

/** The decision, without producing a branded snapshot. Shared by `guardSnapshot` and `recheck`. */
export function exclusionReason(path: string, text: unknown, policy: SweepPolicy): ExclusionReason | null {
    if (typeof path !== 'string' || normalisePath(path) === '') return 'unknown';
    const norm = normalisePath(path);
    if (resolveProtectedFolders(policy.protectedFolders).some((f) => isInsideOrEqual(norm, f))) return 'protected';
    if (policy.excludedFolders.some((f) => normalisePath(f) !== '' && isInsideOrEqual(norm, f))) return 'folder';
    if (typeof text !== 'string') return 'unknown';
    if (!Number.isFinite(policy.maxNoteChars) || policy.maxNoteChars <= 0 || text.length > policy.maxNoteChars) return 'too-large';

    const meta = parseSnapshotMetadata(text);
    if (!meta.frontmatterOk) return 'unreadable';
    const wantedTags = policy.excludedTags.map(normaliseTag).filter(Boolean);
    if (meta.tags.some((tag) => wantedTags.some((w) => tag === w || tag.startsWith(`${w}/`)))) return 'tag';
    for (const entry of policy.excludedProperties) {
        const prop = parseProperty(entry);
        if (!prop) continue;
        if ((Object.hasOwn(meta.properties, prop.key) ? meta.properties[prop.key] : []).some((v) => v.trim().toLowerCase() === prop.value)) return 'property';
    }
    const lower = text.toLowerCase();
    if (policy.excludedTerms.some((term) => term.trim() !== '' && lower.includes(term.trim().toLowerCase()))) return 'term';
    return null;
}

/** Judge a snapshot against the policy it was captured for. */
export function guardSnapshot(snapshot: NoteSnapshot, policy: SweepPolicy, currentRevision: string): GuardResult {
    if (snapshot.policyRevision !== currentRevision) return { allowed: false, reason: 'unknown' };
    const reason = exclusionReason(snapshot.path, snapshot.text, policy);
    if (reason) return { allowed: false, reason };
    return { allowed: true, snapshot: snapshot as GuardedSnapshot };
}

/**
 * Immediately before an outbound call: the snapshot must still be allowed under the policy as it
 * is NOW. A changed policy or path means the snapshot has to be rebuilt and judged again.
 */
export function stillAllowed(snapshot: GuardedSnapshot, policy: SweepPolicy, currentRevision: string, currentPath: string): boolean {
    return snapshot.policyRevision === currentRevision && snapshot.path === currentPath && exclusionReason(currentPath, snapshot.text, policy) === null;
}
