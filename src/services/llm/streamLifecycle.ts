/**
 * One owner for a streaming request's controller, first-byte timer and the
 * listener on the caller's signal (llm-option-fidelity D5).
 *
 * `timeoutMs` on the stream path means exactly one thing: an attempt-level
 * time-to-first-byte deadline. It starts at the request and ends at the first
 * body byte. After the first byte the stream has no deadline; the caller's
 * signal is the only bound.
 *
 * Every terminal path (success, error, abort, timeout, empty stream, fallback)
 * must call `dispose()`, which clears the timer and removes the listener.
 * Live lifecycles are also tracked so plugin unload can abort them
 * (`disposeStreamLifecycles`, symmetric with `disposeAzurePacers`).
 */

/** The first-byte deadline fired. A pre-first-chunk failure: the facade may fall back to non-stream. */
export class StreamFirstByteTimeoutError extends Error {
    constructor(ms: number) {
        super(`No response from the model within ${ms} ms (first-byte timeout)`);
        this.name = 'StreamFirstByteTimeoutError';
    }
}

const live = new Set<StreamLifecycle>();

export class StreamLifecycle {
    private readonly controller = new AbortController();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private onCallerAbort: (() => void) | undefined;
    private firstByteSeen = false;
    private disposedFlag = false;
    private timedOutFlag = false;
    private unloadedFlag = false;

    constructor(private readonly callerSignal: AbortSignal | undefined, private readonly firstByteMs?: number) {
        live.add(this);
        if (callerSignal) {
            if (callerSignal.aborted) {
                this.controller.abort();
            } else {
                this.onCallerAbort = () => this.controller.abort();
                callerSignal.addEventListener('abort', this.onCallerAbort, { once: true });
            }
        }
        if (firstByteMs && firstByteMs > 0 && !this.controller.signal.aborted) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (this.firstByteSeen || this.disposedFlag) return;
                this.timedOutFlag = true;
                this.controller.abort();
            }, firstByteMs);
        }
    }

    /** The signal to hand to `fetch`. */
    get signal(): AbortSignal { return this.controller.signal; }

    /** True when the CALLER (not the deadline, not unload) aborted. Caller abort wins any race. */
    get callerAborted(): boolean { return !!this.callerSignal?.aborted; }

    get timedOut(): boolean { return this.timedOutFlag && !this.callerAborted; }

    get unloaded(): boolean { return this.unloadedFlag; }

    /** The first body byte arrived: the deadline no longer applies. */
    markFirstByte(): void {
        this.firstByteSeen = true;
        this.clearTimer();
    }

    /** Map an error thrown by fetch/read into the error the facade should see. */
    classify(error: unknown): unknown {
        if (this.callerAborted || this.unloadedFlag) {
            return error instanceof DOMException && error.name === 'AbortError'
                ? error
                : new DOMException('Aborted', 'AbortError');
        }
        if (this.timedOut) return new StreamFirstByteTimeoutError(this.firstByteMs ?? 0);
        return error;
    }

    /** Abort because the plugin is unloading; never falls back. */
    abortForUnload(): void {
        this.unloadedFlag = true;
        this.controller.abort();
    }

    dispose(): void {
        if (this.disposedFlag) return;
        this.disposedFlag = true;
        this.clearTimer();
        if (this.onCallerAbort && this.callerSignal) {
            this.callerSignal.removeEventListener('abort', this.onCallerAbort);
        }
        this.onCallerAbort = undefined;
        live.delete(this);
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

/** Abort every in-flight stream (plugin unload). */
export function disposeStreamLifecycles(): void {
    for (const l of [...live]) {
        l.abortForUnload();
        l.dispose();
    }
}

/** Test seam: how many lifecycles are still holding a timer/listener. */
export function activeStreamLifecycleCount(): number {
    return live.size;
}
