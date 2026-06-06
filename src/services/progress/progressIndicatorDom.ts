/**
 * Shared INDETERMINATE waiting indicator (waiting-state-ux).
 *
 * The one presentational builder behind both the chat "thinking" indicator AND
 * ProgressReporter's Notice — dots + phase + an aria-live status fragment + an
 * aria-hidden elapsed ticker + an optional cancel button. NO timer inside (the
 * caller ticks and calls `setElapsed`); NO hardcoded English (all strings are
 * passed in already-localized). This is NOT a determinate progress bar —
 * ProgressReporter keeps `renderProgressBar`/`recordProgress` separately.
 *
 * a11y contract: ONE status element (`role=status` + `aria-live=polite` +
 * `aria-atomic=true`) holds phase + status fragment; the elapsed element is
 * OUTSIDE that region with `aria-hidden=true` (so the 1s ticker never spams a
 * screen reader); cancel is a native `<button>`.
 *
 * Lifecycle: a module-local WeakMap tracks builder-owned roots so re-mounting on
 * the same container destroys the prior one (idempotent) and `destroy()` removes
 * exactly that node + its cancel listener. Never `innerHTML = ''`.
 */

export interface ProgressIndicatorOpts {
    phaseText?: string;
    statusText?: string;
    elapsedText?: string;
    /** Already-localized accessible label for the cancel button. */
    cancelLabel?: string;
    /** Class namespace (default `ai-organiser-progress`). */
    classNamePrefix?: string;
}

export interface ProgressIndicatorHandle {
    /** The root node — exposed so a host that empties + rebuilds its container
     *  (e.g. the chat transcript) can re-append the (detached, not destroyed) indicator. */
    readonly el: HTMLElement;
    setPhase(text: string): void;
    /** Mutates only when the value actually changes (keeps the live region quiet). */
    setStatusFragment(text: string): void;
    setElapsed(text: string): void;
    /** Idempotent: replaces any prior handler; safe to call repeatedly; no-op after destroy. */
    mountCancel(onCancel: () => void): void;
    clearCancel(): void;
    /** Removes the root node + cancel listener; subsequent setters are no-ops. */
    destroy(): void;
}

const ELAPSED_TESTID = 'progress-elapsed';

/** Tracks builder-owned roots per container so mount is idempotent + destroy is precise. */
const owned = new WeakMap<HTMLElement, ProgressIndicatorHandle>();

export function buildProgressIndicator(
    container: HTMLElement,
    opts: ProgressIndicatorOpts = {},
): ProgressIndicatorHandle {
    // Idempotent mount: tear down any prior builder-owned indicator first.
    owned.get(container)?.destroy();

    const prefix = opts.classNamePrefix ?? 'ai-organiser-progress';
    const doc = container.ownerDocument;

    const root = doc.createElement('div');
    root.className = prefix;

    const dots = doc.createElement('span');
    dots.className = `${prefix}-dots`;
    dots.textContent = '•••';
    root.appendChild(dots);

    // ONE live region holding phase + status fragment.
    const statusEl = doc.createElement('span');
    statusEl.className = `${prefix}-status`;
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.setAttribute('aria-atomic', 'true');
    const phaseEl = doc.createElement('span');
    phaseEl.className = `${prefix}-phase`;
    if (opts.phaseText) phaseEl.textContent = opts.phaseText;
    const fragmentEl = doc.createElement('span');
    fragmentEl.className = `${prefix}-fragment`;
    if (opts.statusText) fragmentEl.textContent = opts.statusText;
    statusEl.append(phaseEl, fragmentEl);
    root.appendChild(statusEl);

    // Elapsed — OUTSIDE the live region, aria-hidden (silent ticker).
    const elapsedEl = doc.createElement('span');
    elapsedEl.className = `${prefix}-elapsed`;
    elapsedEl.setAttribute('aria-hidden', 'true');
    elapsedEl.setAttribute('data-testid', ELAPSED_TESTID);
    if (opts.elapsedText) elapsedEl.textContent = opts.elapsedText;
    root.appendChild(elapsedEl);

    container.appendChild(root);

    let cancelBtn: HTMLButtonElement | null = null;
    let cancelHandler: (() => void) | null = null;
    let destroyed = false;

    const removeCancelListener = (): void => {
        if (cancelBtn && cancelHandler) cancelBtn.removeEventListener('click', cancelHandler);
        cancelHandler = null;
    };

    const handle: ProgressIndicatorHandle = {
        el: root,
        setPhase(text: string): void {
            if (destroyed) return;
            if (phaseEl.textContent !== text) phaseEl.textContent = text;
        },
        setStatusFragment(text: string): void {
            if (destroyed) return;
            if (fragmentEl.textContent !== text) fragmentEl.textContent = text;
        },
        setElapsed(text: string): void {
            if (destroyed) return;
            elapsedEl.textContent = text;
        },
        mountCancel(onCancel: () => void): void {
            if (destroyed) return;
            if (!cancelBtn) {
                cancelBtn = doc.createElement('button');
                cancelBtn.className = `${prefix}-cancel`;
                cancelBtn.setAttribute('type', 'button');
                cancelBtn.textContent = '✕';
                root.appendChild(cancelBtn);
            }
            if (opts.cancelLabel) cancelBtn.setAttribute('aria-label', opts.cancelLabel);
            removeCancelListener();
            cancelHandler = onCancel;
            cancelBtn.addEventListener('click', cancelHandler);
        },
        clearCancel(): void {
            removeCancelListener();
            cancelBtn?.remove();
            cancelBtn = null;
        },
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            removeCancelListener();
            root.remove();
            if (owned.get(container) === handle) owned.delete(container);
        },
    };

    owned.set(container, handle);
    return handle;
}
