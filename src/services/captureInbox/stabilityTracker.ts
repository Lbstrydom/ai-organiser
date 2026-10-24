/**
 * Half-synced-file guard. A file event is only a hint; a capture becomes `ready` when the note and
 * every referenced attachment are unchanged across observations at least `stabilityMs` apart.
 * "Stable size" is a heuristic, not proof that a sync finished; a completion marker (see
 * `captureRequireMarker`) is the stronger signal and is checked by the scanner, not here.
 * Pure: the caller supplies the stat results and the clock.
 */
import type { FileObservation } from './captureTypes';

/** One path's current stat, or null when the file does not exist (yet). */
export type StatResult = { size: number; mtime: number } | null;

export type Verdict =
    | { kind: 'ready' }
    | { kind: 'waiting'; reason: 'first-sight' | 'changed' | 'window' | 'missing' | 'empty' };

export interface StabilityOutcome {
    /** Observations to persist (coalesced by the caller) */
    observed: Record<string, FileObservation>;
    verdict: Verdict;
}

/**
 * Compare the current stats with the last observations.
 * - any path missing -> waiting (an attachment may arrive after its note);
 * - any zero-byte file -> waiting;
 * - unchanged since an observation at least `stabilityMs` old -> stable;
 * - first sight of a file already untouched for the whole window -> stable (a cold start or a
 *   manual "Process now" must not wait for a second observation).
 */
export function assess(
    previous: Record<string, FileObservation> | undefined,
    current: Record<string, StatResult>,
    now: number,
    stabilityMs: number,
    /** Trust an old mtime as proof of stability on first sight. Off for file-event hints: sync tools keep the source mtime, so a half-downloaded file can look old. */
    trustMtime = true,
): StabilityOutcome {
    const observed: Record<string, FileObservation> = {};
    let verdict: Verdict = Object.keys(current).length === 0 ? { kind: 'waiting', reason: 'empty' } : { kind: 'ready' };
    const wait = (reason: Extract<Verdict, { kind: 'waiting' }>['reason']): void => {
        if (verdict.kind === 'ready') verdict = { kind: 'waiting', reason };
    };
    for (const [path, stat] of Object.entries(current)) {
        if (stat === null) {
            wait('missing');
            continue;
        }
        if (stat.size <= 0) {
            observed[path] = { size: stat.size, mtime: stat.mtime, at: now };
            wait('empty');
            continue;
        }
        const prev = previous?.[path];
        if (!prev) {
            const untouchedFor = trustMtime && stat.mtime > 0 ? now - stat.mtime : -1;
            if (untouchedFor >= stabilityMs) {
                observed[path] = { size: stat.size, mtime: stat.mtime, at: now - stabilityMs };
            } else {
                observed[path] = { size: stat.size, mtime: stat.mtime, at: now };
                wait('first-sight');
            }
            continue;
        }
        if (prev.size !== stat.size || prev.mtime !== stat.mtime) {
            observed[path] = { size: stat.size, mtime: stat.mtime, at: now };
            wait('changed');
            continue;
        }
        // Unchanged: keep the ORIGINAL observation time so the window can elapse.
        observed[path] = prev;
        if (now - prev.at < stabilityMs) wait('window');
    }
    return { observed, verdict };
}

/** True when `stat` equals the recorded observation (used to ignore the plugin's own writes). */
export function sameAsObserved(observed: FileObservation | undefined, stat: StatResult): boolean {
    return !!observed && !!stat && observed.size === stat.size && observed.mtime === stat.mtime;
}

/**
 * Record the stat of a file the plugin has just written itself, as observed long ago, so the
 * resulting `modify` event neither resets the window nor re-triggers processing.
 */
export function recordSelfWrite(
    observed: Record<string, FileObservation>,
    path: string,
    stat: { size: number; mtime: number },
): Record<string, FileObservation> {
    return { ...observed, [path]: { size: stat.size, mtime: stat.mtime, at: 0 } };
}

/**
 * Observations are persisted on a timer or on a state change, not on every file event. True when
 * the new observations differ from what was last persisted in a way worth a write.
 */
export function observationsChanged(
    persisted: Record<string, FileObservation> | undefined,
    next: Record<string, FileObservation>,
): boolean {
    const a = persisted ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(next)]);
    for (const key of keys) {
        const x = a[key];
        const y = next[key];
        if (!x || !y || x.size !== y.size || x.mtime !== y.mtime) return true;
    }
    return false;
}
