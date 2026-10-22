/**
 * One small controller for the screen's actions, so every button behaves the same way:
 *  - an action is `idle | running | done | failed`, and its result stays available to be shown inline;
 *  - a repeated click while an action (or a conflicting one in its group) runs is ignored, not queued;
 *  - an action that does not finish within its limit ends as `failed`, and a late result is dropped.
 * Pure of Obsidian: the timer is injected so the time limit is tested without waiting.
 */
import type { Result } from '../../core/result';

export type OperationState<T> =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; value: T }
    | { status: 'failed'; error: string };

export interface OperationTimers {
    set(fn: () => void, ms: number): number;
    clear(id: number): void;
}

export class OperationController {
    private readonly states = new Map<string, OperationState<unknown>>();
    private readonly groups = new Map<string, string>();
    /** Jobs that have started and not yet ended, whatever their shown state is. A timed-out job is still here. */
    private readonly inflight = new Set<string>();
    private readonly listeners = new Set<() => void>();

    constructor(private readonly timers: OperationTimers) {}

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    state<T>(id: string): OperationState<T> {
        return (this.states.get(id) as OperationState<T> | undefined) ?? { status: 'idle' };
    }

    /** True while this action, or any other action in the same group, still has a job running (even one that timed out). */
    isBusy(id: string, group?: string): boolean {
        for (const other of this.inflight) {
            if (other === id) return true;
            if (group !== undefined && this.groups.get(other) === group) return true;
        }
        return false;
    }

    /** Forget a finished action's result (for example when the context it belonged to changed). */
    reset(id: string): void {
        if (this.inflight.has(id)) return;
        if (this.states.delete(id)) this.emit();
    }

    /**
     * Start an action. Returns false (and does nothing) when it, or a conflicting one, is already
     * running. A result that arrives after the time limit is ignored.
     */
    async run<T>(id: string, job: () => Promise<Result<T>>, options: { group?: string; limitMs: number; timeoutError: string }): Promise<boolean> {
        if (this.isBusy(id, options.group)) return false;
        this.states.set(id, { status: 'running' });
        this.inflight.add(id);
        // The group belongs to this run only: a later run of the same action without one is not in it.
        if (options.group !== undefined) this.groups.set(id, options.group);
        else this.groups.delete(id);
        this.emit();
        let settled = false;
        const settle = (next: OperationState<unknown>): void => {
            if (settled) return;
            settled = true;
            this.timers.clear(timer);
            this.states.set(id, next);
            this.emit();
        };
        const timer = this.timers.set(() => settle({ status: 'failed', error: options.timeoutError }), options.limitMs);
        try {
            const result = await job();
            settle(result.ok ? { status: 'done', value: result.value } : { status: 'failed', error: result.error });
        } catch {
            settle({ status: 'failed', error: options.timeoutError });
        } finally {
            // Only now, when the job has really ended, is its place in the group released.
            this.inflight.delete(id);
            this.groups.delete(id);
            this.emit();
        }
        return true;
    }

    private emit(): void {
        for (const l of [...this.listeners]) {
            try { l(); } catch { /* a listener must not break an action */ }
        }
    }
}
