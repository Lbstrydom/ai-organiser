/**
 * An in-memory mirror of the notes the capture workflow still holds (everything before Accept), read
 * by the inbox sweep so it waits for Accept instead of sweeping a raw note and then seeing its hash
 * change.
 *
 * Fail closed on two counts:
 *  - until the journal has loaded the mirror says "not loaded", and the sweep refuses to run (or, if
 *    asked anyway, excludes the whole inbox);
 *  - while a sweep is running the mirror is FROZEN: updates are held back and applied afterwards, so
 *    the policy revision cannot change under a running sweep.
 *
 * With the feature off nothing ever calls `setHeld`, and the sweep never looks here.
 */

interface Mirror {
    loaded: boolean;
    held: readonly string[];
}

let current: Mirror = { loaded: false, held: [] };
let active = false;

/**
 * True while the capture registrar is installed. The feature flag alone is not enough: features register only at
 * load, so a flag switched on later has no journal and must not make the sweep wait for one.
 */
export function setCaptureActive(value: boolean): void {
    active = value;
}

export function isCaptureActive(): boolean {
    return active;
}
let frozen = false;
let pending: Mirror | null = null;

export function setHeldMirror(held: readonly string[]): void {
    const next: Mirror = { loaded: true, held: [...held] };
    if (frozen) pending = next;
    else current = next;
}

export function clearHeldMirror(): void {
    current = { loaded: false, held: [] };
    pending = null;
}

export function isHeldMirrorLoaded(): boolean {
    return current.loaded;
}

export function heldMirrorPaths(): readonly string[] {
    return current.held;
}

/** Called around a sweep run. Always pair with `unfreezeHeldMirror` in a finally block. */
export function freezeHeldMirror(): void {
    frozen = true;
}

export function unfreezeHeldMirror(): void {
    frozen = false;
    if (pending) {
        current = pending;
        pending = null;
    }
}
