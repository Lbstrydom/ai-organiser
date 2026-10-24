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
const ACTIVITY_EVENTS = ['scroll', 'wheel', 'pointerdown', 'keydown', 'touchmove'] as const;

interface LiveSession {
    hash: string;
    done: boolean;
    state: ReadSessionState;
    observation: ReadObservation;
    generation: number;
    children: number;
    observed: Set<Element>;
    observer: IntersectionObserver | null;
    timer: number | null;
    cleanup: Array<() => void>;
}

/** One session per rendered view container. A WeakMap, so a closed view releases its session. */
const sessions = new WeakMap<Element, LiveSession>();

function disposeSession(s: LiveSession): void {
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
        const view = findOwningView(host.app, this.el);
        if (!view || view.getMode?.() !== 'preview') return;
        const container = view.containerEl;

        let s = sessions.get(container);
        if (s && s.hash !== this.built.textHash) {
            // Different text on screen means a new render, so a new session. The old one is discarded.
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
        if (this.coversEnd) this.observeEnd(s);
    }

    private createSession(view: MarkdownView, container: HTMLElement): LiveSession {
        const host = this.host;
        const now = host.now ?? (() => performance.now());
        const s: LiveSession = {
            hash: this.built.textHash,
            done: false,
            state: createReadSession(this.built.textHash, this.built.observation.displayed.length),
            observation: this.built.observation,
            generation: host.generation(),
            children: 0,
            observed: new Set(),
            observer: null,
            timer: null,
            cleanup: [],
        };
        s.state = tick(s.state, now(), { visible: true, focused: true, activeLeaf: true });

        const onActivity = () => { s.state = noteActivity(s.state, now()); };
        for (const ev of ACTIVITY_EVENTS) {
            // Capture: scroll does not bubble, and the scroller is a descendant of the view container.
            container.addEventListener(ev, onActivity, { capture: true, passive: true });
            s.cleanup.push(() => container.removeEventListener(ev, onActivity, { capture: true }));
        }

        s.timer = window.setInterval(() => {
            if (s.done) { disposeSession(s); return; }
            if (!host.enabled() || host.generation() !== s.generation) { s.done = true; disposeSession(s); return; }
            const active = host.app.workspace.getActiveViewOfType(MarkdownView) === view;
            s.state = tick(s.state, now(), {
                // The view's own document: correct in a popout window too.
                visible: container.ownerDocument.visibilityState === 'visible',
                focused: container.ownerDocument.hasFocus(),
                activeLeaf: active,
            });
            if (isReadThrough(s.state)) {
                s.done = true;
                disposeSession(s);
                void host.commit(s.observation, s.generation).then((res) => {
                    if (!res.ok) logger.warn('Newsletter', `Read signal not saved: ${res.error}`);
                }).catch((e) => logger.warn('Newsletter', 'Read signal commit threw', e));
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
        s.observer ??= new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) s.state = markEndReached(s.state);
        }, { threshold: 0.6 });
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
        if (!info) return;
        const date = host.digestDate(host.outputRoot(), ctx.sourcePath);
        if (!date) return;
        const loc = locateBrief(info.text);
        if (!loc) return;
        // Only sections that lie inside the managed block.
        if (info.lineEnd <= loc.startLine || info.lineStart >= loc.endLine) return;
        const built = buildObservation(date, info.text);
        if (!built) return;
        const coversEnd = info.lineStart <= loc.lastStoryLine && info.lineEnd >= loc.lastStoryLine;
        const isList = el.querySelector('li') !== null;
        ctx.addChild(new BriefReadChild(el, host, built, coversEnd, isList));
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
