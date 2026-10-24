/**
 * Read session — the pure attentive-dwell state machine behind the Reading-view detector.
 *
 * One session is bound to ONE rendered instance (the caller owns that binding). It decides only
 * whether the evidence adds up to "the reader read this brief"; it never touches the DOM, the
 * clock or storage. Time is passed in (monotonic milliseconds), so every rule is testable with a
 * fake clock.
 *
 * Leaning toward false negatives is deliberate: a story wrongly counted as read is suppressed and
 * the reader never learns they missed it; a story wrongly counted as unread is merely retold.
 */

/** Dwell needed per story in the brief (a skim, not a careful read). */
export const READ_MS_PER_STORY = 2_500;
export const READ_MIN_DWELL_MS = 20_000;
export const READ_MAX_DWELL_MS = 120_000;
/** No scroll/pointer/key event on the surface for this long ⇒ time stops accruing. */
export const READ_IDLE_CUTOFF_MS = 30_000;
/** Distinct activity bursts needed. One touch followed by walking away must never qualify. */
export const READ_MIN_ACTIVITY_BURSTS = 3;
/** Activity closer together than this is one burst (a scroll wheel fires many events). */
export const READ_BURST_GAP_MS = 2_000;
/** One tick may add at most this much, so a throttled timer cannot mint minutes of dwell. */
export const READ_MAX_TICK_MS = 5_000;

export function requiredDwellMs(storyCount: number): number {
    const n = Number.isFinite(storyCount) ? Math.max(0, storyCount) : 0;
    return Math.min(READ_MAX_DWELL_MS, Math.max(READ_MIN_DWELL_MS, n * READ_MS_PER_STORY));
}

export interface ReadSessionState {
    readonly briefTextHash: string;
    readonly storyCount: number;
    readonly dwellMs: number;
    readonly lastTickAt: number | null;
    readonly lastActivityAt: number | null;
    readonly activityBursts: number;
    readonly endReached: boolean;
}

/** Facts about the surface at a tick: all must hold for time to accrue. */
export interface SurfaceSignals {
    /** `document.visibilityState === 'visible'`. */
    visible: boolean;
    /** The window has focus. */
    focused: boolean;
    /** The owning view is the workspace's active leaf. */
    activeLeaf: boolean;
}

export function createReadSession(briefTextHash: string, storyCount: number): ReadSessionState {
    return { briefTextHash, storyCount, dwellMs: 0, lastTickAt: null, lastActivityAt: null, activityBursts: 0, endReached: false };
}

/** An event on THIS surface (scroll, pointer or key inside the view's own container). */
export function noteActivity(state: ReadSessionState, now: number): ReadSessionState {
    const newBurst = state.lastActivityAt === null || now - state.lastActivityAt >= READ_BURST_GAP_MS;
    return { ...state, lastActivityAt: now, activityBursts: state.activityBursts + (newBurst ? 1 : 0) };
}

export function markEndReached(state: ReadSessionState): ReadSessionState {
    return state.endReached ? state : { ...state, endReached: true };
}

/** Advance the clock. Accrues the elapsed time only while the surface is attentive. */
export function tick(state: ReadSessionState, now: number, signals: SurfaceSignals): ReadSessionState {
    const prev = state.lastTickAt;
    if (prev === null) return { ...state, lastTickAt: now };
    const elapsed = Math.min(Math.max(0, now - prev), READ_MAX_TICK_MS);
    const attentive =
        signals.visible && signals.focused && signals.activeLeaf &&
        state.lastActivityAt !== null && now - state.lastActivityAt <= READ_IDLE_CUTOFF_MS;
    return { ...state, lastTickAt: now, dwellMs: attentive ? state.dwellMs + elapsed : state.dwellMs };
}

/** Enough attentive time, real interaction, AND the end of the brief has been on screen. */
export function isReadThrough(state: ReadSessionState): boolean {
    return state.endReached
        && state.activityBursts >= READ_MIN_ACTIVITY_BURSTS
        && state.dwellMs >= requiredDwellMs(state.storyCount);
}
