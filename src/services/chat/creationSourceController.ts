/**
 * Creation Source Controller
 *
 * Handler-level single source of truth for create-flow source state.
 *
 * Responsibilities (audit H7):
 *   - Owns the persisted user choice (`SelectedSource[]`).
 *   - Owns async resolution status keyed by stable source id.
 *   - Owns cached resolved `PromptSource[]` content + per-file mtime so
 *     `resolveForSubmit` doesn't pay for vault reads or web-search calls
 *     a second time (audit Gemini-r2-G1 + r4-G2 + r5-G2).
 *   - Owns the active-leaf-change "stale auto-detected" flag.
 *   - Exposes a reactive `subscribe` contract (audit Gemini-r3 G3).
 *   - Provides the post-resolution generation gate via `resolveForSubmit`
 *     (audit Gemini-r3-G1 — gate moved off the service).
 *
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Item 1).
 */

import type { App, EventRef, TFile } from 'obsidian';
import type {
    SelectedSource,
    PromptSource,
    CreationSourceState,
    GenerationBlockReason,
} from './presentationTypes';
import {
    PresentationSourceService,
    type SourceFailure,
    type ResolveResult,
} from './presentationSourceService';
import { allocateBudget } from './presentationSourceBudget';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';

/** Reason discriminator for subscribe listeners (audit Gemini-r5-G4 +
 *  r7-G3). The panel uses this to decide between full rebuild and
 *  incremental row update. */
export type SourceChangeReason = 'add' | 'remove' | 'reorder' | 'redetect' | 'status' | 'reset';

interface CacheEntry {
    sources: PromptSource[];
    mtimeByPath?: Map<string, number>;       // note + folder kinds
    folderPathsSignature?: string;            // folder kind only
}

let _nextSrcId = 1;
function nextId(): string {
    return `src-${_nextSrcId++}`;
}

export class CreationSourceController {
    private selected: SelectedSource[] = [];
    /** Stable id per row, parallel to `selected[]`. Survives status mutations. */
    private idsBySelected: string[] = [];
    private statusById = new Map<string, CreationSourceState['status']>();
    private failureById = new Map<string, CreationSourceState['failureCode']>();
    private displayLabelById = new Map<string, string>();
    private cappedById = new Map<string, number>();
    private resolvedById = new Map<string, CacheEntry>();
    private autoDetectedStale = false;
    private listeners: Array<(reason: SourceChangeReason) => void> = [];
    private leafChangeRef: EventRef | null = null;

    constructor(
        private readonly app: App,
        private readonly service: PresentationSourceService,
    ) {
        // Listen for active-leaf-change to flag stale auto-detected sources
        // (audit M6 — non-mutating: we set a flag, render path reads it).
        this.leafChangeRef = this.app.workspace.on('active-leaf-change', () => {
            const auto = this.selected[0];
            if (auto?.autoDetected) {
                const current = this.app.workspace.getActiveFile();
                if (current && current.path !== auto.ref) {
                    if (!this.autoDetectedStale) {
                        this.autoDetectedStale = true;
                        this.notify('status');
                    }
                }
            }
        });
    }

    // ── Read snapshot ───────────────────────────────────────────────────────

    getSnapshot(): {
        selected: ReadonlyArray<SelectedSource>;
        states: ReadonlyArray<CreationSourceState>;
        autoDetectedStale: boolean;
    } {
        const states = this.selected.map<CreationSourceState>((sel, i) => ({
            selected: sel,
            status: this.statusById.get(this.idsBySelected[i]) ?? 'idle',
            failureCode: this.failureById.get(this.idsBySelected[i]),
            cappedAt: this.cappedById.get(this.idsBySelected[i]),
            displayLabel: this.displayLabelById.get(this.idsBySelected[i]),
        }));
        return {
            selected: this.selected.slice(),
            states,
            autoDetectedStale: this.autoDetectedStale,
        };
    }

    // ── Mutators ────────────────────────────────────────────────────────────

    addSource(source: SelectedSource): void {
        this.selected.push(source);
        const id = nextId();
        this.idsBySelected.push(id);
        this.statusById.set(id, 'idle');
        this.notify('add');
    }

    removeSource(index: number): void {
        if (index < 0 || index >= this.selected.length) return;
        const id = this.idsBySelected[index];
        this.selected.splice(index, 1);
        this.idsBySelected.splice(index, 1);
        this.purgeId(id);
        this.notify('remove');
    }

    /** User clicked "↻ Use current note". Replaces the auto-detected source
     *  (selected[0]) with a fresh detection from the current active file. */
    redetectActive(): void {
        const fresh = this.service.detectActiveNote();
        if (!fresh) {
            this.autoDetectedStale = false;
            this.notify('redetect');
            return;
        }
        if (this.selected[0]?.autoDetected) {
            this.purgeId(this.idsBySelected[0]);
            this.selected[0] = fresh;
            const id = nextId();
            this.idsBySelected[0] = id;
            this.statusById.set(id, 'idle');
        } else {
            // Insert at top.
            this.selected.unshift(fresh);
            const id = nextId();
            this.idsBySelected.unshift(id);
            this.statusById.set(id, 'idle');
        }
        this.autoDetectedStale = false;
        this.notify('redetect');
    }

    /** Post-generation reset — keep handler instance alive but discard
     *  source state so the next creation cycle starts clean. */
    reset(): void {
        this.selected = [];
        this.idsBySelected = [];
        this.statusById.clear();
        this.failureById.clear();
        this.displayLabelById.clear();
        this.cappedById.clear();
        this.resolvedById.clear();
        this.autoDetectedStale = false;
        this.notify('reset');
    }

    // ── Eager resolution (preload) ──────────────────────────────────────────

    /**
     * Drive resolution proactively when the user adds a source — gives them
     * fast feedback (web-search may take seconds). Each status transition
     * notifies subscribers. On success, caches the resolved content + mtimes
     * (audit Gemini-r2-G1) so `resolveForSubmit` reuses it.
     */
    async preloadAsync(index: number, signal?: AbortSignal): Promise<void> {
        if (index < 0 || index >= this.selected.length) return;
        const id = this.idsBySelected[index];
        const sel = this.selected[index];
        this.statusById.set(id, 'loading');
        this.notify('status');
        let r: ResolveResult;
        try {
            r = await this.service.resolve([sel], { signal });
        } catch {
            this.statusById.set(id, 'error');
            this.failureById.set(id, 'note-read-failed');
            this.notify('status');
            return;
        }
        if (r.usable.length === 0) {
            const failure = r.failures[0];
            this.statusById.set(id, 'error');
            if (failure) this.failureById.set(id, failure.code);
            this.notify('status');
            return;
        }
        this.statusById.set(id, 'resolved');
        this.failureById.delete(id);
        this.cacheResolved(id, sel, r);
        this.notify('status');
    }

    // ── Submit-time resolution + generation gate ────────────────────────────

    /**
     * Reuses cached resolved content for any source whose status === 'resolved'
     * AND whose underlying file mtimes still match (audit Gemini-r4-G2). Folder
     * sources additionally validate the file-list signature so newly-added
     * files in the folder invalidate the cache (audit Gemini-r5-G2). Sources
     * with no cache or stale cache fall through to `service.resolve()`. Then
     * runs `allocateBudget()` and applies the H6 generation gate.
     */
    async resolveForSubmit(
        opts: { folderCap?: number; signal?: AbortSignal } = {},
    ): Promise<Result<{ usable: PromptSource[]; failures: SourceFailure[] }>> {
        if (this.selected.length === 0) {
            return err<{ usable: PromptSource[]; failures: SourceFailure[] }>('zero-selected');
        }

        const cachedSources: PromptSource[] = [];
        const cachedFailures: SourceFailure[] = [];
        const needsResolve: SelectedSource[] = [];

        for (let i = 0; i < this.selected.length; i++) {
            const sel = this.selected[i];
            const id = this.idsBySelected[i];
            const cache = this.resolvedById.get(id);
            const status = this.statusById.get(id);
            if (status === 'resolved' && cache && this.cacheStillValid(sel, cache)) {
                cachedSources.push(...cache.sources);
            } else {
                needsResolve.push(sel);
                this.resolvedById.delete(id);
            }
        }

        let mergedFailures: SourceFailure[] = [...cachedFailures];
        let mergedSources: PromptSource[] = [...cachedSources];
        if (needsResolve.length > 0) {
            const r = await this.service.resolve(needsResolve, { folderCap: opts.folderCap, signal: opts.signal });
            mergedSources = mergedSources.concat(r.usable);
            mergedFailures = mergedFailures.concat(r.failures);
            // Cache the freshly-resolved entries.
            for (let i = 0; i < needsResolve.length; i++) {
                const sel = needsResolve[i];
                const idx = this.selected.indexOf(sel);
                if (idx < 0) continue;
                const id = this.idsBySelected[idx];
                const sourcesForThis = r.usable.filter(s =>
                    sel.kind === 'note' ? s.ref === sel.ref :
                    sel.kind === 'folder' ? s.fromFolder === sel.ref :
                    sel.kind === 'web-search' ? s.kind === 'web-search' && s.ref === sel.ref :
                    false,
                );
                if (sourcesForThis.length > 0) {
                    this.resolvedById.set(id, {
                        sources: sourcesForThis,
                        mtimeByPath: new Map(
                            Array.from(r.mtimeByPath.entries()).filter(([p]) =>
                                sourcesForThis.some(s => s.ref === p)),
                        ),
                        folderPathsSignature: r.folderPathsSignature?.get(sel.ref),
                    });
                    this.statusById.set(id, 'resolved');
                    this.failureById.delete(id);
                } else {
                    this.statusById.set(id, 'error');
                    const fail = r.failures.find(f => f.selected === sel);
                    if (fail) this.failureById.set(id, fail.code);
                }
            }
            this.notify('status');
        }

        const allocated = allocateBudget(mergedSources);
        if (allocated.length === 0) {
            return err<{ usable: PromptSource[]; failures: SourceFailure[] }>('no-usable-sources' satisfies GenerationBlockReason);
        }
        return ok({ usable: allocated, failures: mergedFailures });
    }

    // ── Subscriptions (audit Gemini-r3-G3) ──────────────────────────────────

    subscribe(listener: (reason: SourceChangeReason) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    private notify(reason: SourceChangeReason): void {
        for (const l of this.listeners) {
            try { l(reason); } catch { /* listener errors don't kill the controller */ }
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    dispose(): void {
        if (this.leafChangeRef) {
            this.app.workspace.offref(this.leafChangeRef);
            this.leafChangeRef = null;
        }
        this.listeners = [];
        this.reset();
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    private purgeId(id: string): void {
        this.statusById.delete(id);
        this.failureById.delete(id);
        this.displayLabelById.delete(id);
        this.cappedById.delete(id);
        this.resolvedById.delete(id);
    }

    private cacheResolved(id: string, sel: SelectedSource, r: ResolveResult): void {
        const sourcesForThis = r.usable.filter(s =>
            sel.kind === 'note' ? s.ref === sel.ref :
            sel.kind === 'folder' ? s.fromFolder === sel.ref :
            sel.kind === 'web-search' ? s.kind === 'web-search' && s.ref === sel.ref :
            false,
        );
        if (sourcesForThis.length === 0) return;
        this.resolvedById.set(id, {
            sources: sourcesForThis,
            mtimeByPath: new Map(
                Array.from(r.mtimeByPath.entries()).filter(([p]) =>
                    sourcesForThis.some(s => s.ref === p)),
            ),
            folderPathsSignature: r.folderPathsSignature?.get(sel.ref),
        });
    }

    private cacheStillValid(sel: SelectedSource, cache: CacheEntry): boolean {
        if (sel.kind === 'web-search') return true;  // no mtime to validate
        if (sel.kind === 'note') {
            const abs = this.app.vault.getAbstractFileByPath(sel.ref);
            if (!isTFile(abs)) return false;
            const cached = cache.mtimeByPath?.get(sel.ref);
            return cached === abs.stat.mtime;
        }
        if (sel.kind === 'folder') {
            // Re-enumerate to check signature; cheap (no file reads).
            const abs = this.app.vault.getAbstractFileByPath(sel.ref);
            if (!abs || !('children' in abs)) return false;
            const live = collectFolderMdPaths(abs as { children: unknown[] }).sort().join('\x00');
            if (live !== cache.folderPathsSignature) return false;
            // All cached files still have unchanged mtimes
            for (const [path, mtime] of cache.mtimeByPath ?? []) {
                const f = this.app.vault.getAbstractFileByPath(path);
                if (!isTFile(f) || f.stat.mtime !== mtime) return false;
            }
            return true;
        }
        return false;
    }
}

function isTFile(f: unknown): f is TFile {
    return !!f && typeof f === 'object' && 'stat' in f && 'extension' in f
        && (f as { extension: unknown }).extension === 'md';
}

function collectFolderMdPaths(folder: { children: unknown[] }): string[] {
    const paths: string[] = [];
    const walk = (f: { children: unknown[] }): void => {
        for (const child of f.children) {
            if (isTFile(child)) paths.push(child.path);
            else if (child && typeof child === 'object' && 'children' in child) {
                walk(child as { children: unknown[] });
            }
        }
    };
    walk(folder);
    return paths;
}
