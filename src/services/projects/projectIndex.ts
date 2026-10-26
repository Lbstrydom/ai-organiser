/**
 * The project index: which notes are projects, areas or containers, by their hidden `aio-id`. Pure functions over plain
 * data; the Obsidian-facing wrapper is `projectService.ts`.
 *
 * Identity is the id, never a path or a name. Two keys: `aio-id` (a UUID) and `aio-role` (`project`, `area` or
 * `container`). A note with an id but no or an unknown role is unadopted and offered for adoption. An id on two notes
 * (a copied note) is a duplicate: both are listed and nothing that needs identity runs for that id until the user keeps one.
 */
import { Result, ok, err } from '../../core/result';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { rootOf, type ParaKind, type ParaRoot } from './paraRoots';

export const AIO_ID_KEY = 'aio-id';
export const AIO_ROLE_KEY = 'aio-role';

export type ProjectRole = 'project' | 'area' | 'container';
const ROLES: readonly ProjectRole[] = ['project', 'area', 'container'];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isAioId = (value: unknown): value is string => typeof value === 'string' && UUID_V4.test(value.trim());

export function newAioId(): string {
    return crypto.randomUUID();
}

/** What the index needs to know about one note. */
export interface NoteIdentity {
    path: string;
    frontmatter: Record<string, unknown> | null | undefined;
}

export type Pairing = 'none' | 'drive-pending' | 'paired';

export interface ProjectRef {
    aioId: string;
    notePath: string;
    folder: string;
    rootKind: ParaKind | null;
    /** The user's own `status` value, trimmed (empty when the note has none) */
    status: string;
    pairing: Pairing;
}

export interface AnchorRef {
    aioId: string;
    notePath: string;
    role: ProjectRole;
}

export interface UnadoptedNote {
    path: string;
    /** Why it is offered: an id with no role, or an id that is not a UUID */
    reason: 'no-role' | 'unknown-role' | 'invalid-id';
}

export interface ProjectIndex {
    projects: ProjectRef[];
    anchors: AnchorRef[];
    /** id -> every note path that carries it (only ids carried by two or more notes) */
    duplicates: Map<string, string[]>;
    unadopted: UnadoptedNote[];
}

const folderOf = (path: string): string => {
    const p = normalisePath(path);
    const at = p.lastIndexOf('/');
    return at === -1 ? '' : p.slice(0, at);
};

/** The user's `status`: a string, or the first string of a list; trimmed. */
export function statusOf(frontmatter: Record<string, unknown> | null | undefined): string {
    const raw = frontmatter?.status;
    if (typeof raw === 'string') return raw.trim();
    if (Array.isArray(raw)) {
        const first = raw.find((v): v is string => typeof v === 'string' && v.trim() !== '');
        return first ? first.trim() : '';
    }
    return '';
}

function roleOf(frontmatter: Record<string, unknown>): ProjectRole | null {
    const raw = frontmatter[AIO_ROLE_KEY];
    return typeof raw === 'string' && (ROLES as readonly string[]).includes(raw.trim()) ? (raw.trim() as ProjectRole) : null;
}

export interface BuildOptions {
    roots?: readonly ParaRoot[];
    pairingOf?: (aioId: string) => Pairing;
}

export function buildProjectIndex(notes: readonly NoteIdentity[], options: BuildOptions = {}): ProjectIndex {
    const roots = options.roots ?? [];
    const byId = new Map<string, string[]>();
    const projects: ProjectRef[] = [];
    const anchors: AnchorRef[] = [];
    const unadopted: UnadoptedNote[] = [];
    for (const note of notes) {
        const fm = note.frontmatter;
        if (!fm || !Object.hasOwn(fm, AIO_ID_KEY)) continue;
        const id = fm[AIO_ID_KEY];
        if (!isAioId(id)) { unadopted.push({ path: note.path, reason: 'invalid-id' }); continue; }
        const aioId = id.trim().toLowerCase();
        const role = roleOf(fm);
        if (!role) {
            unadopted.push({ path: note.path, reason: Object.hasOwn(fm, AIO_ROLE_KEY) ? 'unknown-role' : 'no-role' });
            continue;
        }
        byId.set(aioId, [...(byId.get(aioId) ?? []), note.path]);
        anchors.push({ aioId, notePath: note.path, role });
        if (role === 'project') {
            projects.push({
                aioId,
                notePath: note.path,
                folder: folderOf(note.path),
                rootKind: rootOf(note.path, roots)?.kind ?? null,
                status: statusOf(fm),
                pairing: options.pairingOf?.(aioId) ?? 'none',
            });
        }
    }
    const duplicates = new Map([...byId].filter(([, paths]) => paths.length > 1));
    const byPath = (a: { notePath: string }, b: { notePath: string }): number => a.notePath.localeCompare(b.notePath);
    return { projects: projects.sort(byPath), anchors: anchors.sort(byPath), duplicates, unadopted: unadopted.sort((a, b) => a.path.localeCompare(b.path)) };
}

export type ProjectErrorCode = 'project-not-found' | 'duplicate-project-id' | 'project-id-invalid';

/** Resolve any role by id. A duplicated id resolves to nothing: the user must keep one note first. */
export function resolveAnchor(index: ProjectIndex, aioId: string): Result<AnchorRef> {
    if (!isAioId(aioId)) return err('project-id-invalid');
    const id = aioId.trim().toLowerCase();
    if (index.duplicates.has(id)) return err('duplicate-project-id');
    const hit = index.anchors.find((a) => a.aioId === id);
    return hit ? ok(hit) : err('project-not-found');
}

/** Resolve a PROJECT (role `project`) by id. */
export function resolveProject(index: ProjectIndex, aioId: string): Result<ProjectRef> {
    const anchor = resolveAnchor(index, aioId);
    if (!anchor.ok) return err(anchor.error);
    if (anchor.value.role !== 'project') return err('project-not-found');
    const ref = index.projects.find((p) => p.aioId === anchor.value.aioId);
    return ref ? ok(ref) : err('project-not-found');
}

export type SourceProject =
    | { kind: 'project'; aioId: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; candidates: string[] };

export interface SourceProjectPort {
    /** The `project` frontmatter value of the source note, if it has one (a wikilink or text) */
    projectLink(sourcePath: string): string | null;
    /** Resolve a link the way Obsidian does, from the source note, to a vault path */
    resolveLink(link: string, fromPath: string): string | null;
}

/**
 * Which project a note belongs to, by one fixed order: (1) the note is itself a project note; (2) a `project` frontmatter
 * link to a project note; (3) containment, where a project's scope is its note's folder only when that note is the folder's
 * single project note (two project notes in one folder give that folder no scope) and the innermost scope wins; (4) none.
 * `ambiguous` never sets an id: a review that needs the project asks with the picker.
 */
export function resolveSourceProject(index: ProjectIndex, sourcePath: string, port?: SourceProjectPort): SourceProject {
    const source = normalisePath(sourcePath);
    const own = index.projects.find((p) => normalisePath(p.notePath) === source);
    if (own) return index.duplicates.has(own.aioId) ? { kind: 'ambiguous', candidates: index.duplicates.get(own.aioId) ?? [] } : { kind: 'project', aioId: own.aioId };

    const link = port?.projectLink(sourcePath);
    if (link) {
        const target = port?.resolveLink(link, sourcePath);
        const hit = target ? index.projects.find((p) => normalisePath(p.notePath) === normalisePath(target)) : undefined;
        if (hit) return index.duplicates.has(hit.aioId) ? { kind: 'ambiguous', candidates: index.duplicates.get(hit.aioId) ?? [] } : { kind: 'project', aioId: hit.aioId };
    }

    const perFolder = new Map<string, ProjectRef[]>();
    for (const project of index.projects) perFolder.set(normalisePath(project.folder), [...(perFolder.get(normalisePath(project.folder)) ?? []), project]);
    let best: { folder: string; project: ProjectRef } | null = null;
    for (const [folder, list] of perFolder) {
        // A project note at the vault root has no folder scope; two in one folder give it none either.
        if (folder === '' || list.length !== 1) continue;
        if (!isInsideOrEqual(source, folder)) continue;
        if (!best || folder.length > best.folder.length) best = { folder, project: list[0] };
    }
    if (!best) return { kind: 'none' };
    return index.duplicates.has(best.project.aioId) ? { kind: 'ambiguous', candidates: index.duplicates.get(best.project.aioId) ?? [] } : { kind: 'project', aioId: best.project.aioId };
}

/** Rank projects for the picker: a case-insensitive match on title, folder, status or root kind; stable order. */
export function searchProjects(projects: readonly ProjectRef[], query: string): ProjectRef[] {
    const q = query.trim().toLowerCase();
    const title = (p: ProjectRef): string => p.notePath.slice(p.notePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    if (q === '') return [...projects].sort((a, b) => title(a).localeCompare(title(b)));
    const score = (p: ProjectRef): number => {
        const t = title(p).toLowerCase();
        if (t === q) return 0;
        if (t.startsWith(q)) return 1;
        if (t.includes(q)) return 2;
        if (p.folder.toLowerCase().includes(q) || p.status.toLowerCase().includes(q) || (p.rootKind ?? '').includes(q)) return 3;
        return -1;
    };
    return projects.map((p) => ({ p, s: score(p) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s || title(a.p).localeCompare(title(b.p))).map((x) => x.p);
}
