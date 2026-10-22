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
    private readonly listeners = new Set<() => void>();

    constructor(private readonly timers: OperationTimers) {}

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    state<T>(id: string): OperationState<T> {
        return (this.states.get(id) as OperationState<T> | undefined) ?? { status: 'idle' };
    }

    /** True while this action, or any other action in the same group, is running. */
    isBusy(id: string, group?: string): boolean {
        for (const [other, state] of this.states) {
            if (state.status !== 'running') continue;
            if (other === id) return true;
            if (group !== undefined && this.groups.get(other) === group) return true;
        }
        return false;
    }

    /**
     * Start an action. Returns false (and does nothing) when it, or a conflicting one, is already
     * running. A result that arrives after the time limit is ignored.
     */
    async run<T>(id: string, job: () => Promise<Result<T>>, options: { group?: string; limitMs: number; timeoutError: string }): Promise<boolean> {
        if (this.isBusy(id, options.group)) return false;
        this.states.set(id, { status: 'running' });
        if (options.group !== undefined) this.groups.set(id, options.group);
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
        }
        return true;
    }

    private emit(): void {
        for (const l of [...this.listeners]) {
            try { l(); } catch { /* a listener must not break an action */ }
        }
    }
}
