import { describe, it, expect } from 'vitest';
import {
    READ_IDLE_CUTOFF_MS,
    READ_MAX_DWELL_MS,
    READ_MAX_TICK_MS,
    READ_MIN_ACTIVITY_BURSTS,
    READ_MIN_DWELL_MS,
    createReadSession,
    isReadThrough,
    markEndReached,
    noteActivity,
    requiredDwellMs,
    tick,
    type ReadSessionState,
    type SurfaceSignals,
} from '../src/services/newsletter/newsletterReadSession';

const ON: SurfaceSignals = { visible: true, focused: true, activeLeaf: true };

/** Run `seconds` of 1-second ticks, with activity at the start. */
function run(state: ReadSessionState, from: number, seconds: number, signals: SurfaceSignals = ON, activityEvery = 10): { state: ReadSessionState; now: number } {
    let s = state;
    let now = from;
    for (let i = 0; i < seconds; i++) {
        now += 1000;
        if (i % activityEvery === 0) s = noteActivity(s, now);
        s = tick(s, now, signals);
    }
    return { state: s, now };
}

describe('requiredDwellMs', () => {
    it('scales with story count and is clamped', () => {
        expect(requiredDwellMs(0)).toBe(READ_MIN_DWELL_MS);
        expect(requiredDwellMs(4)).toBe(READ_MIN_DWELL_MS);
        expect(requiredDwellMs(16)).toBe(40_000);
        expect(requiredDwellMs(500)).toBe(READ_MAX_DWELL_MS);
        expect(requiredDwellMs(Number.NaN)).toBe(READ_MIN_DWELL_MS);
    });
});

describe('read session', () => {
    it('needs BOTH enough attentive time and the end of the brief on screen', () => {
        let s = createReadSession('h', 4);
        s = tick(s, 0, ON);
        const dwelled = run(s, 0, 25).state;
        expect(dwelled.dwellMs).toBeGreaterThanOrEqual(READ_MIN_DWELL_MS);
        expect(isReadThrough(dwelled)).toBe(false);
        expect(dwelled.activityBursts).toBeGreaterThanOrEqual(READ_MIN_ACTIVITY_BURSTS);
        expect(isReadThrough(markEndReached(dwelled))).toBe(true);
        expect(isReadThrough(markEndReached(createReadSession('h', 4)))).toBe(false);
    });

    it('a fast fling to the bottom is not a read', () => {
        let s = tick(createReadSession('h', 10), 0, ON);
        s = noteActivity(s, 500);
        s = markEndReached(tick(s, 1000, ON));
        expect(isReadThrough(s)).toBe(false);
    });

    it('does not accrue while hidden, unfocused, or not the active leaf (typing in another pane)', () => {
        for (const off of [{ ...ON, visible: false }, { ...ON, focused: false }, { ...ON, activeLeaf: false }]) {
            const base = tick(createReadSession('h', 4), 0, ON);
            const { state } = run(base, 0, 60, off);
            expect(state.dwellMs).toBe(0);
        }
    });

    it('one touch then walking away never qualifies, even with the end on screen', () => {
        const base = noteActivity(tick(createReadSession('h', 4), 0, ON), 0);
        const { state } = run(base, 0, 300, ON, 100000);
        expect(isReadThrough(markEndReached(state))).toBe(false);
    });

    it('a digest left open and untouched stops accruing after the idle cutoff', () => {
        const base = noteActivity(tick(createReadSession('h', 4), 0, ON), 0);
        const { state } = run(base, 0, 300, ON, 100000);
        expect(state.dwellMs).toBeLessThanOrEqual(READ_IDLE_CUTOFF_MS + 1000);
        expect(state.dwellMs).toBeLessThan(requiredDwellMs(4) * 4);
    });

    it('never accrues without any activity on the surface', () => {
        const { state } = run(tick(createReadSession('h', 4), 0, ON), 0, 120, ON, 1_000_000_000);
        // run() notes activity at i=0 only; use a state that never had activity
        let s = tick(createReadSession('h', 4), 0, ON);
        for (let t = 1000; t <= 120_000; t += 1000) s = tick(s, t, ON);
        expect(s.dwellMs).toBe(0);
        expect(state.dwellMs).toBeGreaterThanOrEqual(0);
    });

    it('a single throttled tick cannot mint more than the per-tick cap', () => {
        let s = noteActivity(tick(createReadSession('h', 4), 0, ON), 1);
        s = tick(s, 10 * 60_000, ON);
        expect(s.dwellMs).toBeLessThanOrEqual(READ_MAX_TICK_MS);
    });

    it('the first tick only anchors the clock', () => {
        const s = tick(noteActivity(createReadSession('h', 4), 0), 5000, ON);
        expect(s.dwellMs).toBe(0);
        expect(s.lastTickAt).toBe(5000);
    });

    it('clock going backwards adds nothing', () => {
        let s = noteActivity(tick(createReadSession('h', 4), 10_000, ON), 10_000);
        s = tick(s, 9_000, ON);
        expect(s.dwellMs).toBe(0);
    });
});
