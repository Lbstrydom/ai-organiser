/**
 * The project service: the only code that knows what a project is. Filing, reconcile and the AI hand-back call it; none
 * of them creates a project note or assigns an id itself.
 *
 * It owns the identity keys (`aio-id`, `aio-role`), the index built from the metadata cache (rebuilt when a note changes),
 * `adoptProject` (one reviewed edit that adds the keys to an existing note: nothing is moved) and the resolvers.
 *
 * Gate: the service exists only while a consumer is enabled (`projectServiceActive`). Off, nothing is built, no listener is
 * registered and nothing is written.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { isFeatureEnabled } from '../featureService';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { logger } from '../../utils/logger';
import { normaliseParaRoots, type ParaRoot } from './paraRoots';
import { planAdoption } from './projectAdoption';
import {
    buildProjectIndex, resolveAnchor, resolveProject, resolveSourceProject, searchProjects,
    type AnchorRef, type ProjectIndex, type ProjectRef, type ProjectRole, type SourceProject,
} from './projectIndex';

/**
 * The features whose work needs project identity. Each slice that adds a consumer adds it here, once.
 * Fail closed: with none enabled the service does not exist.
 */
export function projectServiceActive(settings: Parameters<typeof isFeatureEnabled>[0]): boolean {
    return isFeatureEnabled(settings, 'google-tasks-export') || isFeatureEnabled(settings, 'ai-workspaces');
}

export interface AdoptOutcome {
    aioId: string;
    notePath: string;
    role: ProjectRole;
}

const WIKILINK = /^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;

/** The path part of a `[[wikilink]]` value, or the value itself when it is plain text. */
export function linkpathOf(value: string): string {
    const m = WIKILINK.exec(value);
    return (m ? m[1] : value).trim();
}

export class ProjectService {
    private cached: ProjectIndex | null = null;
    /** The roots the cached index was built with: a changed setting rebuilds it */
    private cachedRoots = '';
    private disposed = false;

    constructor(private readonly plugin: AIOrganiserPlugin) {}

    /** Register the listeners that keep the index current. Called once, only while a consumer is enabled. */
    start(): void {
        const { app } = this.plugin;
        const dirty = (): void => { this.cached = null; };
        this.plugin.registerEvent(app.metadataCache.on('changed', dirty));
        this.plugin.registerEvent(app.metadataCache.on('deleted', dirty));
        this.plugin.registerEvent(app.vault.on('rename', dirty));
        this.plugin.register(() => { this.disposed = true; this.cached = null; });
    }

    roots(): ParaRoot[] {
        return normaliseParaRoots(this.plugin.settings.paraRoots);
    }

    /** The index, rebuilt from the metadata cache when a note has changed since it was built. */
    index(): ProjectIndex {
        const rootsKey = JSON.stringify(this.roots());
        if (this.cached && !this.disposed && rootsKey === this.cachedRoots) return this.cached;
        const { app } = this.plugin;
        const notes = app.vault.getMarkdownFiles().map((f) => ({ path: f.path, frontmatter: app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined }));
        const built = buildProjectIndex(notes, { roots: this.roots() });
        if (!this.disposed) { this.cached = built; this.cachedRoots = rootsKey; }
        return built;
    }

    /** Force the next read to rebuild (after a write the cache has not seen yet). */
    invalidate(): void {
        this.cached = null;
    }

    projects(): ProjectRef[] {
        return this.index().projects;
    }

    search(query: string): ProjectRef[] {
        return searchProjects(this.projects(), query);
    }

    resolveAnchor(aioId: string): Result<AnchorRef> {
        return resolveAnchor(this.index(), aioId);
    }

    resolveProject(aioId: string): Result<ProjectRef> {
        return resolveProject(this.index(), aioId);
    }

    /** Which project a note belongs to (see `resolveSourceProject`). */
    resolveSourceProject(sourcePath: string): SourceProject {
        const { app } = this.plugin;
        return resolveSourceProject(this.index(), sourcePath, {
            projectLink: (path) => {
                const file = app.vault.getAbstractFileByPath(path);
                const raw = file instanceof TFile ? (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined)?.project : undefined;
                return typeof raw === 'string' && raw.trim() !== '' ? linkpathOf(raw) : null;
            },
            resolveLink: (link, from) => app.metadataCache.getFirstLinkpathDest(link, from)?.path ?? null,
        });
    }

    /**
     * Adopt an existing note: one reviewed edit adds `aio-id`, `aio-role` and (for a project with none) `status: active`.
     * Nothing is moved, renamed or re-written. A note that already carries a role is refused, never silently changed.
     */
    adoptProject(notePath: string): Promise<Result<AdoptOutcome>> {
        return this.adopt(notePath, 'project');
    }

    /** Adopt a note as an Area or a container (a Reference anchor, a root anchor for Drive pairs): no status is added. */
    adoptContainer(notePath: string, role: 'area' | 'container'): Promise<Result<AdoptOutcome>> {
        return this.adopt(notePath, role);
    }

    private async adopt(notePath: string, role: ProjectRole): Promise<Result<AdoptOutcome>> {
        try {
            const { app } = this.plugin;
            const file = app.vault.getAbstractFileByPath(notePath);
            if (!(file instanceof TFile) || file.extension !== 'md') return err('project-not-found');
            const baseline = await app.vault.read(file);
            const first = planAdoption(baseline, role);
            if (!first.ok) return err(first.error);
            // An id that two notes carry is not adopted further: the user keeps one first.
            if (this.index().duplicates.has(first.value.aioId)) return err('duplicate-project-id');
            // The id is fixed by the first plan, so the preview and the write add the same id.
            const fixed = first.value.aioId;
            const res = await applyNoteEdit(this.plugin, {
                kind: 'composite',
                filePath: file.path,
                baseline,
                recompute: (current) => {
                    const plan = planAdoption(current, role, () => fixed);
                    return plan.ok ? ok({ content: plan.value.text }) : err(plan.error);
                },
            });
            if (!res.ok) return err(res.error);
            this.invalidate();
            return ok({ aioId: fixed, notePath: file.path, role });
        } catch (e) {
            logger.error('Projects', 'Adopt failed', e);
            return err('project-adopt-failed');
        }
    }
}

// ─── One service per plugin, created lazily and only while a consumer is enabled ────────────────

const services = new WeakMap<AIOrganiserPlugin, ProjectService>();

/** The service if it already exists (never creates one: safe to call from a render). */
export function peekProjectService(plugin: AIOrganiserPlugin): ProjectService | null {
    return projectServiceActive(plugin.settings) ? services.get(plugin) ?? null : null;
}

/** The project service, or null when no consumer is enabled (nothing is built then). */
export function getProjectService(plugin: AIOrganiserPlugin): ProjectService | null {
    if (!projectServiceActive(plugin.settings)) return null;
    let service = services.get(plugin);
    if (!service) {
        service = new ProjectService(plugin);
        service.start();
        services.set(plugin, service);
    }
    return service;
}
