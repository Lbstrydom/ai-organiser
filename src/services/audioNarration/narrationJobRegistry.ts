/**
 * Typed concurrency control for narration jobs.
 * Replaces ad hoc `_narrationInFlight` property on the plugin (M2 fix).
 */

export class JobInFlightError extends Error {
    readonly code = 'IN_FLIGHT';
    constructor(filePath: string) {
        super(`Narration job already in flight for: ${filePath}`);
        this.name = 'JobInFlightError';
    }
}

export class NarrationJobRegistry {
    private readonly jobs = new Map<string, AbortController>();

    has(filePath: string): boolean {
        return this.jobs.has(filePath);
    }

    get(filePath: string): AbortController | undefined {
        return this.jobs.get(filePath);
    }

    /** Throws JobInFlightError if a job is already running for this filePath. */
    start(filePath: string): AbortController {
        if (this.jobs.has(filePath)) {
            throw new JobInFlightError(filePath);
        }
        const ac = new AbortController();
        this.jobs.set(filePath, ac);
        return ac;
    }

    cancel(filePath: string): void {
        this.jobs.get(filePath)?.abort();
    }

    finish(filePath: string): void {
        this.jobs.delete(filePath);
    }

    /** Best-effort cleanup on plugin unload — aborts every in-flight job. */
    abortAll(): void {
        for (const ac of this.jobs.values()) {
            try { ac.abort(); } catch { /* ignore */ }
        }
        this.jobs.clear();
    }

    get size(): number {
        return this.jobs.size;
    }

    /**
     * Scoped execution helper — guarantees `finish(filePath)` runs even on
     * exception or early return (audit H8 fix). Prefer this over manual
     * start/finish so callers can't leak registry entries.
     *
     * @param filePath  Job key. Snapshot BEFORE async work to survive renames (G3).
     * @param fn        Worker; receives the AbortController for cancellation wiring.
     */
    async runJob<T>(
        filePath: string,
        fn: (ac: AbortController) => Promise<T>,
    ): Promise<T> {
        const ac = this.start(filePath);  // throws JobInFlightError on collision
        try {
            return await fn(ac);
        } finally {
            this.finish(filePath);
        }
    }
}
