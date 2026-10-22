/**
 * A single-flight interval job. Pure of Obsidian: the clock and the timer are injected, so the
 * schedule, the mutex and the backoff are tested without waiting.
 *
 * Rules (the vault upkeep sweep's scheduler safety):
 *  - one run at a time: a tick while a run is active does nothing, and a manual run while one is
 *    active is refused;
 *  - a tick runs only when the job is due: `now - lastAttemptEnd >= wait`, where the wait is the
 *    configured interval, or after failures the backed-off delay (never shorter than the interval);
 *  - the first tick after `start()` is immediate, so an overdue run happens at start-up, like the
 *    newsletter scheduler;
 *  - context gates (page hidden, mobile, interactive work in flight) skip the tick without
 *    counting as a failure;
 *  - the mutex is released in `finally`, so a thrown run can never wedge the job.
 */
export type IntervalChoice = 'off' | 'hourly' | 'daily' | 'weekly' | 'custom';

export const MIN_CUSTOM_MINUTES = 15;
export const MAX_CUSTOM_MINUTES = 10_080;
const MS_MINUTE = 60_000;
const MS_DAY = 24 * 60 * MS_MINUTE;

/** The interval in milliseconds, or null for "off" (manual runs only). */
export function intervalMs(choice: IntervalChoice, customMinutes: number): number | null {
    switch (choice) {
        case 'hourly': return 60 * MS_MINUTE;
        case 'daily': return MS_DAY;
        case 'weekly': return 7 * MS_DAY;
        case 'custom': {
            const minutes = Number.isFinite(customMinutes) ? Math.min(MAX_CUSTOM_MINUTES, Math.max(MIN_CUSTOM_MINUTES, Math.floor(customMinutes))) : 1440;
            return minutes * MS_MINUTE;
        }
        default: return null;
    }
}

/**
 * How long to wait after `failures` failed runs, measured from the end of the failed attempt:
 * `max(interval, min(interval * 2^failures, max(interval, 24 h)))`. Never earlier than the interval,
 * never later than the larger of one day and the interval.
 */
export function backoffMs(interval: number, failures: number): number {
    if (failures <= 0) return interval;
    const cap = Math.max(interval, MS_DAY);
    return Math.max(interval, Math.min(interval * 2 ** Math.min(failures, 20), cap));
}

/** Whether a run is due now. */
export function isDue(now: number, lastAttemptEnd: number | null, interval: number, failures: number): boolean {
    if (lastAttemptEnd === null) return true;
    return now - lastAttemptEnd >= backoffMs(interval, failures);
}

/** When the next automatic run is due, or null when automatic runs are off. */
export function nextRunAt(lastAttemptEnd: number | null, interval: number | null, failures: number, now: number): number | null {
    if (interval === null) return null;
    return lastAttemptEnd === null ? now : lastAttemptEnd + backoffMs(interval, failures);
}

/** How often the job looks at the clock: often enough to notice it is due, rarely enough to cost nothing. */
export function tickPeriodMs(interval: number): number {
    return Math.min(15 * MS_MINUTE, Math.max(MS_MINUTE, Math.floor(interval / 4)));
}

export interface JobClock {
    now(): number;
    setInterval(fn: () => void, ms: number): number;
    clearInterval(id: number): void;
}

export interface JobConfig {
    /** null = automatic runs are off */
    intervalMs: number | null;
    /** When the last attempt ended (success or failure), or null if none */
    lastAttemptEnd: number | null;
    failures: number;
}

export type TickOutcome = 'ran' | 'failed' | 'off' | 'not-due' | 'busy' | 'context';

export interface IntervalJobOptions {
    clock: JobClock;
    config(): JobConfig;
    /** False while the page is hidden, on mobile without opt-in, or while interactive work is in flight */
    canRun(): boolean;
    /** Perform one run. Never throws past the job: a throw counts as a failed run. */
    run(trigger: 'scheduled'): Promise<void>;
    /** Called when a run threw, so the host can count the attempt (otherwise the job would retry on every tick) */
    onFailure?(error: unknown): void;
    /** Called with the interval id so the host can register it for cleanup on unload */
    onTimer?(id: number): void;
}

export class IntervalJob {
    private timer: number | null = null;
    private active = false;

    constructor(private readonly options: IntervalJobOptions) {}

    get running(): boolean { return this.active; }

    /** Start (or restart) the schedule. The first tick is immediate. */
    start(): void {
        this.stop();
        const interval = this.options.config().intervalMs;
        if (interval === null) return;
        this.timer = this.options.clock.setInterval(() => { void this.tick(); }, tickPeriodMs(interval));
        this.options.onTimer?.(this.timer);
        void this.tick();
    }

    stop(): void {
        if (this.timer !== null) {
            this.options.clock.clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** One look at the clock. Resolves when a run it started has ended. */
    async tick(): Promise<TickOutcome> {
        const cfg = this.options.config();
        if (cfg.intervalMs === null) return 'off';
        if (this.active) return 'busy';
        if (!isDue(this.options.clock.now(), cfg.lastAttemptEnd, cfg.intervalMs, cfg.failures)) return 'not-due';
        if (!this.options.canRun()) return 'context';
        this.active = true;
        try {
            await this.options.run('scheduled');
        } catch (e) {
            // The job stays usable, and the host is told so the attempt counts toward the backoff.
            this.active = false;
            try { this.options.onFailure?.(e); } catch { /* a failing hook must not wedge the job */ }
            return 'failed';
        } finally {
            this.active = false;
        }
        return 'ran';
    }

    /**
     * Claim the mutex for a manual run. Returns a release function, or null when a run is already
     * active. The caller releases it in a `finally`.
     */
    claim(): (() => void) | null {
        if (this.active) return null;
        this.active = true;
        return () => { this.active = false; };
    }
}
