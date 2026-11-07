/**
 * When to rebuild a live pack: a quiet time after the last change to one of its notes (minutes, not seconds), with a maximum wait
 * under continuous editing. Which paths matter comes from the snapshots the service delivers (project note, Area note, context
 * sources, held notes), so a changed `area` link is watched as soon as the project note is read again. Timers only: the service
 * decides what may be written.
 */
import type { CandidateSnapshot, LivePackService } from './livePackService';
import { logger } from '../../utils/logger';

export interface SchedulerTimers {
    set(fn: () => void, ms: number): number;
    clear(id: number): void;
    now(): number;
}

export const LIVE_MAX_WAIT_MS = 30 * 60 * 1000;
export const LIVE_CATCH_UP_MS = 60 * 1000;

const key = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

export class LivePackScheduler {
    /** path -> projects that read it */
    private readonly watchers = new Map<string, Set<string>>();
    /** project -> the paths it reads */
    private readonly paths = new Map<string, Set<string>>();
    /** project -> its project note (a change there re-collects the candidates at once) */
    private readonly projectNotes = new Map<string, string>();
    private readonly timers = new Map<string, { id: number; firstAt: number }>();
    private catchUp: number | null = null;
    private stopped = false;

    constructor(private readonly service: LivePackService, private readonly delayMs: () => number, private readonly t: SchedulerTimers) {
        service.onSnapshot = (s) => this.applySnapshot(s);
        service.onRetry = (id) => this.schedule(id);
    }

    /** Replace what one project watches with what its newest snapshot read. */
    applySnapshot(s: CandidateSnapshot): void {
        if (this.stopped) return;
        this.forget(s.aioId);
        if (!this.service.ownedProjects().includes(s.aioId)) return;
        const set = new Set<string>([s.projectPath, ...(s.areaPath ? [s.areaPath] : []), ...s.contextSources, ...s.notes.map((n) => n.path)].map(key));
        this.paths.set(s.aioId, set);
        this.projectNotes.set(s.aioId, key(s.projectPath));
        for (const p of set) {
            const w = this.watchers.get(p) ?? new Set<string>();
            w.add(s.aioId);
            this.watchers.set(p, w);
        }
    }

    private forget(aioId: string): void {
        for (const p of this.paths.get(aioId) ?? []) {
            const w = this.watchers.get(p);
            w?.delete(aioId);
            if (w && w.size === 0) this.watchers.delete(p);
        }
        this.paths.delete(aioId);
        this.projectNotes.delete(aioId);
    }

    /** A note was changed (its cache updated), created, deleted or renamed. */
    touched(path: string): void {
        if (this.stopped) return;
        const k = key(path);
        // Copies first: a snapshot delivered during the loop replaces these maps' entries.
        const projects = [...this.projectNotes].filter(([, note]) => note === k).map(([id]) => id);
        const watchers = [...(this.watchers.get(k) ?? [])];
        for (const id of projects) void this.service.recollect(id);
        for (const id of watchers) this.schedule(id);
    }

    /** Debounce one project: restart its quiet timer, but never wait longer than the maximum since the first change. */
    schedule(aioId: string): void {
        if (this.stopped) return;
        const now = this.t.now();
        const existing = this.timers.get(aioId);
        if (existing) this.t.clear(existing.id);
        const firstAt = existing?.firstAt ?? now;
        const wait = Math.max(0, Math.min(this.delayMs(), firstAt + LIVE_MAX_WAIT_MS - now));
        const id = this.t.set(() => this.fire(aioId), wait);
        this.timers.set(aioId, { id, firstAt });
    }

    private fire(aioId: string): void {
        this.timers.delete(aioId);
        if (this.stopped) return;
        this.service.refresh(aioId).then((r) => {
            if (!r.ok) logger.warn('AiWorkspaces', `Live pack not refreshed: ${r.error}`);
        }, (e: unknown) => logger.warn('AiWorkspaces', 'Live pack refresh failed', e));
    }

    /** Read every owned project's notes now; after a minute, one refresh each (edits that arrived by sync while closed). */
    start(): void {
        for (const id of this.service.ownedProjects()) void this.service.recollect(id);
        this.catchUp = this.t.set(() => {
            this.catchUp = null;
            for (const id of this.service.ownedProjects()) this.schedule(id);
        }, LIVE_CATCH_UP_MS);
    }

    /** After a consent change or a settings save: watch exactly what the owned projects read now. */
    resync(): void {
        if (this.stopped) return;
        const owned = new Set(this.service.ownedProjects());
        for (const id of [...this.paths.keys()]) if (!owned.has(id)) this.forget(id);
        // A refresh waiting for a project that is no longer live here is dropped.
        for (const [id, timer] of [...this.timers]) if (!owned.has(id)) { this.t.clear(timer.id); this.timers.delete(id); }
        for (const id of owned) void this.service.recollect(id);
    }

    stop(): void {
        this.stopped = true;
        for (const { id } of this.timers.values()) this.t.clear(id);
        this.timers.clear();
        if (this.catchUp !== null) this.t.clear(this.catchUp);
        this.catchUp = null;
        this.watchers.clear();
        this.paths.clear();
        this.projectNotes.clear();
        this.service.onSnapshot = null;
        this.service.onRetry = null;
    }

    /** For tests and the status line: projects with a refresh waiting. */
    pending(): string[] {
        return [...this.timers.keys()];
    }
}
