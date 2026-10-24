/**
 * Brief read observer — the Reading-view detector for the read signal.
 *
 * DOM glue only. The decision "did the reader read this brief" is the pure state machine in
 * `newsletterReadSession.ts`; what was read is matched to the ledger by content in
 * `newsletterReadSignal.ts`. This file wires them to a rendered note.
 *
 * Binding rules (each one closes a false positive):
 *  - one live session per RENDERED INSTANCE (the owning view's container), never per note path;
 *  - the snapshot is parsed from `getSectionInfo(el).text` — the markdown the render was produced
 *    from — once, not stitched together from section callbacks;
 *  - activity counts only when it happens ON that container, and time accrues only while that
 *    view is the active leaf (typing in another pane does not read this one);
 *  - the session is a render-scoped `MarkdownRenderChild`, so it is torn down with the section
 *    rather than retained until the plugin unloads;
 *  - every commit is re-checked against the collection generation inside the serialized write.
 */

import { MarkdownRenderChild, MarkdownView, type App, type MarkdownPostProcessorContext } from 'obsidian';
import type { Result } from '../../core/result';
import { logger } from '../../utils/logger';
import type { ReadCommitOutcome, ReadObservation } from '../../services/newsletter/newsletterMemoryTypes';
import { buildObservation, locateBrief } from '../../services/newsletter/newsletterReadSignal';
import {
    createReadSession,
    isReadThrough,
    markEndReached,
    noteActivity,
    tick,
    type ReadSessionState,
} from '../../services/newsletter/newsletterReadSession';

export interface BriefReadHost {
    app: App;
    /** Live check: read-through mode is on (and story memory with it). */
    enabled: () => boolean;
    /** The newsletter output root, to authenticate the digest path. */
    outputRoot: () => string;
    /** Resolve a note path to its digest bucket date, or null. */
    digestDate: (outputRoot: string, path: string) => string | null;
    /** Record the read. Refused/failed results are handled here; never throws. */
    commit: (observation: ReadObservation, generation: number) => Promise<Result<ReadCommitOutcome>>;
    /** The current collection generation. */
    generation: () => number;
    /** Monotonic milliseconds. */
    now?: () => number;
}

const TICK_MS = 1_000;
/** Fraction of the last item that must be on screen. ONE value: it configures the observer and validates each entry. */
const END_VISIBLE_RATIO = 0.6;
const ACTIVITY_EVENTS = ['scroll', 'wheel', 'pointerdown', 'keydown', 'touchmove'] as const;

interface LiveSession {
    hash: string;
    /** The bucket date the snapshot belongs to: part of the session identity, with the text hash. */
    date: string;
    /** The end of the brief is on screen RIGHT NOW (latest observation), whether or not the reader is attentive. */
    endVisible: boolean;
    /** Committed or refused for this exact text: a tombstone, so the same text is never committed twice. */
    done: boolean;
    /** Torn down without finishing (unload, mode off, purge): a later render of the same text starts afresh. */
    dead: boolean;
    state: ReadSessionState;
    observation: ReadObservation;
    generation: number;
    children: number;
    observed: Set<Element>;
    observer: IntersectionObserver | null;
    timer: number | null;
    cleanup: Array<() => void>;
    /** Is the surface attentive right now? End evidence is gated exactly like dwell. */
    eligible: () => boolean;
}

/** One session per rendered view container. A WeakMap, so a closed view releases its session. */
const sessions = new WeakMap<Element, LiveSession>();

function disposeSession(s: LiveSession): void {
    s.dead = true;
    if (s.timer !== null) { window.clearInterval(s.timer); s.timer = null; }
    s.observer?.disconnect();
    s.observer = null;
    s.observed.clear();
    for (const fn of s.cleanup.splice(0)) fn();
}

function findOwningView(app: App, el: HTMLElement): MarkdownView | null {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.containerEl.contains(el)) return view;
    }
    return null;
}

class BriefReadChild extends MarkdownRenderChild {
    private session: LiveSession | null = null;
    private disposed = false;

    constructor(
        private readonly el: HTMLElement,
        private readonly host: BriefReadHost,
        private readonly built: { observation: ReadObservation; textHash: string },
        private readonly coversEnd: boolean,
        private readonly isListSection: boolean,
        /** Captured synchronously with the observation, before any deferred work. */
        private readonly generation: number,
    ) {
        super(el);
    }

    onload(): void {
        // The element is not guaranteed to be in the document yet when the child loads.
        window.setTimeout(() => { if (!this.disposed) this.bind(); }, 0);
    }

    onunload(): void {
        this.disposed = true;
        const s = this.session;
        if (!s) return;
        s.children -= 1;
        if (s.children <= 0) disposeSession(s);
    }

    private bind(): void {
        const host = this.host;
        if (!host.enabled()) return;
        // A purge or mode change between attach and this deferred bind makes the observation stale.
        if (host.generation() !== this.generation) return;
        const view = findOwningView(host.app, this.el);
        if (!view || view.getMode?.() !== 'preview') { logger.debug('ReadSignal', `no preview view owns this section (view: ${view ? view.getMode?.() : 'none'})`); return; }
        const container = view.containerEl;

        let s = sessions.get(container);
        // A completed session is a tombstone only for the lifecycle it completed in: after a purge or a mode
        // change (a new generation) the same text may be read again.
        const staleTombstone = s?.done === true && s.generation !== host.generation();
        if (s && (s.hash !== this.built.textHash || s.date !== this.built.observation.date || (s.dead && !s.done) || staleTombstone)) {
            // Different text on screen means a new render, so a new session; a session that was torn
            // down without finishing (the last child unloaded, mode switched off) is replaced, not reused.
            disposeSession(s);
            s = undefined;
        }
        if (!s) {
            s = this.createSession(view, container);
            sessions.set(container, s);
        }
        if (s.done) return; // already committed (or refused) for this exact text
        s.children += 1;
        this.session = s;
        logger.debug('ReadSignal', `bound section (coversEnd=${this.coversEnd}, children=${s.children}, date=${s.date})`);
        if (this.coversEnd) this.observeEnd(s);
    }

    private createSession(view: MarkdownView, container: HTMLElement): LiveSession {
        const host = this.host;
        const now = host.now ?? (() => performance.now());
        const s: LiveSession = {
            hash: this.built.textHash,
            date: this.built.observation.date,
            endVisible: false,
            done: false,
            dead: false,
            state: createReadSession(this.built.textHash, this.built.observation.displayed.length),
            observation: this.built.observation,
            generation: this.generation,
            children: 0,
            observed: new Set(),
            observer: null,
            timer: null,
            cleanup: [],
            eligible: () => false,
        };
        s.state = tick(s.state, now(), { visible: true, focused: true, activeLeaf: true });

        // The view's own document: correct in a popout window too.
        const surfaceSignals = () => ({
            visible: container.ownerDocument.visibilityState === 'visible',
            focused: container.ownerDocument.hasFocus(),
            activeLeaf: host.app.workspace.getActiveViewOfType(MarkdownView) === view,
        });
        s.eligible = () => { const sig = surfaceSignals(); return sig.visible && sig.focused && sig.activeLeaf; };

        const onActivity = () => { s.state = noteActivity(s.state, now()); };
        for (const ev of ACTIVITY_EVENTS) {
            // Capture: scroll does not bubble, and the scroller is a descendant of the view container.
            container.addEventListener(ev, onActivity, { capture: true, passive: true });
            s.cleanup.push(() => container.removeEventListener(ev, onActivity, { capture: true }));
        }

        s.timer = window.setInterval(() => {
            if (s.done) { disposeSession(s); return; }
            if (!host.enabled() || host.generation() !== s.generation) { disposeSession(s); return; }
            s.state = tick(s.state, now(), surfaceSignals());
            // Visibility seen while the pane was inactive counts the moment it becomes attentive.
            if (s.endVisible && s.eligible()) s.state = markEndReached(s.state);
            if (s.state.lastTickAt !== null && Math.round(s.state.dwellMs / 1000) % 10 === 0 && s.state.dwellMs > 0) {
                logger.debug('ReadSignal', `dwell=${Math.round(s.state.dwellMs / 1000)}s bursts=${s.state.activityBursts} end=${s.state.endReached} visible=${s.endVisible} eligible=${s.eligible()}`);
            }
            if (isReadThrough(s.state)) {
                s.done = true;
                disposeSession(s);
                // done blocks a second concurrent commit while this one is pending; a FAILED save puts the
                // session back to not-done so the next render of this text can try again.
                void host.commit(s.observation, s.generation).then((res) => {
                    if (!res.ok) { s.done = false; logger.warn('Newsletter', `Read signal not saved: ${res.error}`); }
                }).catch((e) => { s.done = false; logger.warn('Newsletter', 'Read signal commit threw', e); });
            }
        }, TICK_MS);
        return s;
    }

    private observeEnd(s: LiveSession): void {
        if (typeof IntersectionObserver === 'undefined') return; // fail closed: no end evidence, no implicit read
        // A list section holds every bullet under one element: watch its LAST item, not its top.
        const items = this.isListSection ? this.el.querySelectorAll('li') : null;
        const target: Element = items && items.length > 0 ? items[items.length - 1] : this.el;
        if (s.observed.has(target)) return;
        s.observed.add(target);
        // The container's own window: correct for a popout, where the global observer would watch the wrong viewport.
        const Observer = this.el.ownerDocument.defaultView?.IntersectionObserver ?? window.IntersectionObserver;
        s.observer ??= new Observer((entries) => {
            // A background, unfocused or inactive view being scrolled past the end is not a reader at the end.
            // Record what is on screen; whether it COUNTS is decided by eligibility, now and at every tick.
            if (entries.length > 0) s.endVisible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= END_VISIBLE_RATIO);
            if (s.endVisible && s.eligible()) s.state = markEndReached(s.state);
        }, { threshold: END_VISIBLE_RATIO });
        s.observer.observe(target);
    }
}

/**
 * Attach the detector to one rendered section. Cheap and side-effect free unless the section is
 * part of a digest's Daily Brief block in a markdown view.
 */
export function attachBriefReadObserver(el: HTMLElement, ctx: MarkdownPostProcessorContext, host: BriefReadHost): void {
    try {
        if (!host.enabled()) return;
        const info = ctx.getSectionInfo(el);
        if (!info) { logger.debug('ReadSignal', 'no section info for a rendered section'); return; }
        const date = host.digestDate(host.outputRoot(), ctx.sourcePath);
        if (!date) return;
        const loc = locateBrief(info.text);
        if (!loc) { logger.debug('ReadSignal', `section of ${ctx.sourcePath} has no brief block in its section text`); return; }
        // Only sections that lie inside the managed block.
        if (info.lineEnd <= loc.startLine || info.lineStart >= loc.endLine) return;
        const built = buildObservation(date, info.text);
        if (!built) { logger.debug('ReadSignal', 'brief block did not parse into stories'); return; }
        const coversEnd = info.lineStart <= loc.lastStoryLine && info.lineEnd >= loc.lastStoryLine;
        const isList = el.querySelector('li') !== null;
        ctx.addChild(new BriefReadChild(el, host, built, coversEnd, isList, host.generation()));
    } catch (e) {
        logger.warn('Newsletter', 'Brief read observer could not attach', e);
    }
}

/** Test seam: forget every live session held for a container. */
export function __disposeSessionFor(container: Element): void {
    const s = sessions.get(container);
    if (s) disposeSession(s);
    sessions.delete(container);
}
