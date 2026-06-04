/**
 * Foreground gate (D3) — a ref-counted boolean mutex marking "a user-initiated
 * LLM op is in flight". The embedding indexer reads `isActive()` and yields
 * while it's held, so background indexing never contends with a foreground
 * generation for the same rate-limited provider.
 *
 * Constructed ONCE in `onload` (D0) and lives for the plugin's lifetime — never
 * in `initializeLLMService` (which re-runs on every saveSettings; reconstructing
 * would reset the ref-count mid-build).
 *
 * Acquired ONLY via `withForeground(fn)` (acquire → try/finally release) so a
 * throwing op can never leak the count. Ref-counted so a nested op (e.g.
 * presentation grounding inside a build) doesn't end the gate early.
 */
export class ForegroundGate {
    private count = 0;
    private readonly idleListeners = new Set<() => void>();

    /** True while at least one foreground op is in flight. */
    isActive(): boolean {
        return this.count > 0;
    }

    /**
     * Run `fn` while the gate is held. The count is released in `finally` even
     * if `fn` throws/rejects, and the result/error propagates unchanged.
     */
    async withForeground<T>(fn: () => Promise<T>): Promise<T> {
        this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    /**
     * Subscribe to the end→idle transition (last release). Returns an
     * unsubscribe fn. The embedding queue uses this to wake its drain — it
     * subscribes once per yield and unsubscribes the moment it fires, so
     * repeated yields never accumulate listeners.
     */
    onIdle(listener: () => void): () => void {
        this.idleListeners.add(listener);
        return () => this.idleListeners.delete(listener);
    }

    private acquire(): void {
        this.count++;
    }

    private release(): void {
        if (this.count === 0) return; // defensive: never go negative
        this.count--;
        if (this.count === 0) {
            // Snapshot before firing — a listener that re-subscribes (or
            // unsubscribes) mid-iteration must not mutate the live set.
            const listeners = [...this.idleListeners];
            for (const listener of listeners) {
                try {
                    listener();
                } catch {
                    // A misbehaving listener must not strand the gate.
                }
            }
        }
    }
}
