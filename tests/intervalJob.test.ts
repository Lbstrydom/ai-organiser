import { describe, it, expect } from 'vitest';
import { IntervalJob, backoffMs, intervalMs, isDue, nextRunAt, tickPeriodMs, type JobClock, type JobConfig } from '../src/services/upkeep/intervalJob';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('intervalMs', () => {
	it('maps the choices, and off to null', () => {
		expect(intervalMs('off', 60)).toBeNull();
		expect(intervalMs('hourly', 5)).toBe(HOUR);
		expect(intervalMs('daily', 5)).toBe(DAY);
		expect(intervalMs('weekly', 5)).toBe(7 * DAY);
	});

	it('clamps a custom interval to 15 minutes to a week and survives nonsense', () => {
		expect(intervalMs('custom', 1)).toBe(15 * MIN);
		expect(intervalMs('custom', 120)).toBe(2 * HOUR);
		expect(intervalMs('custom', 10_000_000)).toBe(7 * DAY);
		expect(intervalMs('custom', NaN)).toBe(DAY);
	});
});

describe('backoff', () => {
	it('is the interval itself with no failures', () => {
		expect(backoffMs(HOUR, 0)).toBe(HOUR);
	});

	it('doubles per failure, capped at a day for short intervals', () => {
		expect(backoffMs(HOUR, 1)).toBe(2 * HOUR);
		expect(backoffMs(HOUR, 2)).toBe(4 * HOUR);
		expect(backoffMs(HOUR, 10)).toBe(DAY);
	});

	it('never retries earlier than the configured interval, even for weekly and custom long intervals', () => {
		for (const interval of [DAY, 3 * DAY, 7 * DAY]) {
			for (let f = 0; f <= 12; f++) expect(backoffMs(interval, f)).toBeGreaterThanOrEqual(interval);
		}
		expect(backoffMs(7 * DAY, 1)).toBe(7 * DAY);
	});

	it('is due only when the (backed-off) wait has passed since the last attempt ended', () => {
		expect(isDue(1000, null, HOUR, 0)).toBe(true);
		expect(isDue(HOUR - 1, 0, HOUR, 0)).toBe(false);
		expect(isDue(HOUR, 0, HOUR, 0)).toBe(true);
		expect(isDue(HOUR, 0, HOUR, 1)).toBe(false); // backed off to two hours
		expect(isDue(2 * HOUR, 0, HOUR, 1)).toBe(true);
		expect(nextRunAt(1000, HOUR, 0, 5)).toBe(1000 + HOUR);
		expect(nextRunAt(1000, null, 0, 5)).toBeNull();
		expect(nextRunAt(null, HOUR, 0, 5)).toBe(5);
	});

	it('ticks often enough to notice a due run and rarely enough to cost nothing', () => {
		expect(tickPeriodMs(HOUR)).toBe(15 * MIN);
		expect(tickPeriodMs(DAY)).toBe(15 * MIN);
		expect(tickPeriodMs(15 * MIN)).toBe(3.75 * MIN);
		expect(tickPeriodMs(MIN)).toBe(MIN);
	});
});

function harness(over: Partial<JobConfig> = {}) {
	let now = 10 * DAY;
	const cfg: JobConfig = { intervalMs: DAY, lastAttemptEnd: null, failures: 0, ...over };
	const timers = new Map<number, () => void>();
	let nextId = 1;
	const clock: JobClock = {
		now: () => now,
		setInterval: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
		clearInterval: (id) => { timers.delete(id); },
	};
	const state = { canRun: true, runs: 0, release: null as null | (() => void), throwOnRun: false, registered: [] as number[] };
	const job = new IntervalJob({
		clock,
		config: () => cfg,
		canRun: () => state.canRun,
		run: async () => {
			state.runs++;
			if (state.throwOnRun) throw new Error('boom');
			if (state.release === null) { cfg.lastAttemptEnd = now; return; }
			await new Promise<void>((resolve) => { state.release = resolve; });
			cfg.lastAttemptEnd = now;
		},
		onTimer: (id) => state.registered.push(id),
	});
	return { job, cfg, timers, state, advance: (ms: number) => { now += ms; } };
}

describe('IntervalJob', () => {
	it('does nothing when automatic runs are off: no timer, no run', async () => {
		const h = harness({ intervalMs: null });
		h.job.start();
		expect(h.timers.size).toBe(0);
		expect(await h.job.tick()).toBe('off');
		expect(h.state.runs).toBe(0);
	});

	it('registers one timer and runs an overdue job immediately at start', async () => {
		const h = harness();
		h.job.start();
		expect(h.timers.size).toBe(1);
		expect(h.state.registered).toEqual([1]);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.state.runs).toBe(1);
	});

	it('restarting replaces the timer instead of stacking another, and stop() clears it', () => {
		const h = harness({ lastAttemptEnd: 10 * DAY });
		h.job.start();
		h.job.start();
		expect(h.timers.size).toBe(1);
		h.job.stop();
		expect(h.timers.size).toBe(0);
		h.job.stop(); // idempotent
	});

	it('skips ticks until due, then runs once', async () => {
		const h = harness({ lastAttemptEnd: 10 * DAY });
		expect(await h.job.tick()).toBe('not-due');
		h.advance(DAY - 1);
		expect(await h.job.tick()).toBe('not-due');
		h.advance(1);
		expect(await h.job.tick()).toBe('ran');
		expect(await h.job.tick()).toBe('not-due'); // the run reset the clock
		expect(h.state.runs).toBe(1);
	});

	it('is single-flight: a tick during a run does nothing, and a manual claim is refused', async () => {
		const h = harness();
		h.state.release = () => undefined;
		const first = h.job.tick();
		await Promise.resolve();
		expect(h.job.running).toBe(true);
		expect(await h.job.tick()).toBe('busy');
		expect(h.job.claim()).toBeNull();
		h.state.release?.();
		await first;
		expect(h.job.running).toBe(false);
		const release = h.job.claim();
		expect(release).not.toBeNull();
		expect(await h.job.tick()).toBe('busy'); // a manual run holds the mutex too
		release?.();
		expect(h.state.runs).toBe(1);
	});

	it('releases the mutex when a run throws, so the job is never wedged', async () => {
		const h = harness();
		h.state.throwOnRun = true;
		expect(await h.job.tick()).toBe('ran');
		expect(h.job.running).toBe(false);
		h.state.throwOnRun = false;
		expect(await h.job.tick()).toBe('ran');
	});

	it('skips, without counting a run, when the context says no', async () => {
		const h = harness();
		h.state.canRun = false;
		expect(await h.job.tick()).toBe('context');
		expect(h.state.runs).toBe(0);
		h.state.canRun = true;
		expect(await h.job.tick()).toBe('ran');
	});

	it('uses the backed-off wait after a failure', async () => {
		const h = harness({ intervalMs: HOUR, lastAttemptEnd: 10 * DAY, failures: 2 });
		h.advance(3 * HOUR);
		expect(await h.job.tick()).toBe('not-due'); // four hours of backoff
		h.advance(HOUR);
		expect(await h.job.tick()).toBe('ran');
	});
});
