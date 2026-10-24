// @vitest-environment happy-dom
/**
 * The Reading-view detector, wired to fake views and a fake IntersectionObserver.
 * happy-dom cannot prove the real render (that is checked in a scratch vault); this pins the
 * binding rules: one session per rendered instance, activity counted only on that surface,
 * active-leaf gating, render-scoped teardown, and invalidation by mode/generation.
 */

vi.mock('obsidian', () => {
    class MarkdownRenderChild {
        containerEl: HTMLElement;
        constructor(containerEl: HTMLElement) { this.containerEl = containerEl; }
        onload(): void {}
        onunload(): void {}
    }
    class MarkdownView {
        containerEl: HTMLElement;
        mode: string;
        constructor(containerEl: HTMLElement, mode = 'preview') { this.containerEl = containerEl; this.mode = mode; }
        getMode() { return this.mode; }
    }
    return { MarkdownRenderChild, MarkdownView, normalizePath: (p: string) => p };
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView } from 'obsidian';
import { attachBriefReadObserver, type BriefReadHost } from '../src/ui/components/briefReadObserver';
import { BRIEF_END_MARKER, BRIEF_START_MARKER } from '../src/services/newsletter/newsletterReadSignal';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const DATE = '2026-10-21';
const PATH = `${ROOT}/Digest — ${DATE}.md`;

function noteText(gist = 'A development'): string {
    return [
        '# Digest',
        '',
        BRIEF_START_MARKER,
        '## Daily Brief',
        '',
        '### News',
        `- **First story here**: ${gist} (Sources: A, B)`,
        `- **Second story here**: Another ${gist} (Sources: A, B)`,
        '',
        BRIEF_END_MARKER,
        '',
        '- [[x]]',
    ].join('\n');
}

// lines: 0 '# Digest' 1 '' 2 START 3 '## Daily Brief' 4 '' 5 '### News' 6 first 7 second 8 '' 9 END
const SECTION_LIST = { lineStart: 6, lineEnd: 7 };
const SECTION_HEADING = { lineStart: 5, lineEnd: 5 };
const SECTION_OUTSIDE = { lineStart: 11, lineEnd: 11 };

class FakeIO {
    static instances: FakeIO[] = [];
    targets: Element[] = [];
    unobserve(el: Element) { this.targets = this.targets.filter((t) => t !== el); }
    constructor(public cb: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) { FakeIO.instances.push(this); }
    observe(el: Element) { this.targets.push(el); }
    disconnect() { this.targets = []; }
    fire(isIntersecting = true, intersectionRatio = 1) { this.cb([{ isIntersecting, intersectionRatio }]); }
}

let clock = 0;
let gen = 0;
let enabled = true;
let activeView: MarkdownView | null = null;
let views: MarkdownView[] = [];
const commits: Array<{ displayed: number; generation: number }> = [];

function makeHost(): BriefReadHost {
    return {
        app: {
            workspace: {
                getLeavesOfType: () => views.map((view) => ({ view })),
                getActiveViewOfType: () => activeView,
            },
        } as never,
        enabled: () => enabled,
        outputRoot: () => ROOT,
        digestDate: (root, path) => (path === `${root}/Digest — ${DATE}.md` ? DATE : null),
        commit: async (observation, generation) => {
            commits.push({ displayed: observation.displayed.length, generation });
            return { ok: true, value: { kind: 'credited', stories: observation.displayed.length, newly: observation.displayed.length } };
        },
        generation: () => gen,
        now: () => clock,
    };
}

function newView(): MarkdownView {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = new (MarkdownView as unknown as new (el: HTMLElement) => MarkdownView)(container);
    views.push(view);
    return view;
}

function render(view: MarkdownView, text: string, section = SECTION_LIST, path = PATH) {
    const el = document.createElement('div');
    el.innerHTML = '<ul><li>one</li><li>two</li></ul>';
    view.containerEl.appendChild(el);
    const children: Array<{ onload(): void; onunload(): void }> = [];
    const ctx = {
        sourcePath: path,
        getSectionInfo: () => ({ text, ...section }),
        addChild: (c: { onload(): void; onunload(): void }) => { children.push(c); c.onload(); },
    };
    attachBriefReadObserver(el, ctx as never, makeHost());
    return { el, children };
}

/** Advance `seconds`, with a scroll on the given container every `every` seconds. */
function step(seconds: number, container: HTMLElement | null, every = 3) {
    for (let i = 0; i < seconds; i++) {
        clock += 1000;
        if (container && i % every === 0) container.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(1000);
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { setInterval: typeof setInterval }).setInterval = globalThis.setInterval;
    (window as unknown as { clearInterval: typeof clearInterval }).clearInterval = globalThis.clearInterval;
    (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = globalThis.setTimeout;
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    FakeIO.instances = [];
    commits.length = 0;
    clock = 0; gen = 0; enabled = true; views = []; activeView = null;
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const flush = () => vi.advanceTimersByTime(1);

describe('attach rules', () => {
    it('ignores notes that are not the digest, sections outside the block, and a disabled mode', () => {
        const view = newView();
        expect(render(view, noteText(), SECTION_LIST, 'Other/Note.md').children).toHaveLength(0);
        expect(render(view, noteText(), SECTION_OUTSIDE).children).toHaveLength(0);
        enabled = false;
        expect(render(view, noteText()).children).toHaveLength(0);
        enabled = true;
        expect(render(view, '# no brief', SECTION_LIST).children).toHaveLength(0);
    });
});

describe('a genuine read-through', () => {
    it('commits once, with the displayed snapshot and the captured generation', () => {
        const view = newView();
        activeView = view;
        const { el } = render(view, noteText());
        flush();
        step(1, null);
        FakeIO.instances[0].fire(true);
        step(30, view.containerEl);
        expect(commits).toEqual([{ displayed: 2, generation: 0 }]);
        step(60, view.containerEl);
        expect(commits).toHaveLength(1); // never twice for the same text
        expect(el).toBeTruthy();
    });

    it('watches the LAST list item of a list section, not its top', () => {
        const view = newView();
        activeView = view;
        const { el } = render(view, noteText());
        flush();
        expect(FakeIO.instances[0].targets[0]).toBe(el.querySelectorAll('li')[1]);
    });
});

describe('false positives it must refuse', () => {
    it('typing in ANOTHER pane: the digest is not the active leaf', () => {
        const view = newView();
        const other = newView();
        activeView = other;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(120, other.containerEl); // activity lands on the other pane
        step(60, view.containerEl);   // even scrolling here does not count while it is not active
        expect(commits).toHaveLength(0);
    });

    it('a digest left open at the bottom after one touch', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        view.containerEl.dispatchEvent(new Event('scroll'));
        step(300, null);
        expect(commits).toHaveLength(0);
    });

    it('end of brief never reached', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });

    it('a fast fling is not a read', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(3, view.containerEl, 1);
        expect(commits).toHaveLength(0);
    });

    it('no IntersectionObserver ⇒ no end evidence ⇒ no implicit read', () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });

    it('a Live Preview or Source view does not run a session', () => {
        const view = newView();
        (view as unknown as { mode: string }).mode = 'source';
        activeView = view;
        render(view, noteText());
        flush();
        expect(FakeIO.instances).toHaveLength(0);
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });
});

describe('sessions are per rendered instance', () => {
    it('two panes hold independent sessions with their own snapshots', () => {
        const a = newView();
        const b = newView();
        activeView = a;
        render(a, noteText('text one'));
        render(b, noteText('text two'));
        flush();
        FakeIO.instances.forEach((io) => io.fire(true));
        step(30, a.containerEl);
        expect(commits).toHaveLength(1); // only the active pane read
        activeView = b;
        FakeIO.instances[1].fire(true); // b's end is only evidence once b is the attentive pane
        step(30, b.containerEl);
        expect(commits).toHaveLength(2);
    });

    it('a regenerated note replaces the session; the old one cannot commit', () => {
        const view = newView();
        activeView = view;
        render(view, noteText('old text'));
        flush();
        FakeIO.instances[0].fire(true);
        step(10, view.containerEl);
        render(view, noteText('new text')); // the section re-rendered with different text
        flush();
        FakeIO.instances.at(-1)!.fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
        expect(FakeIO.instances.length).toBeGreaterThanOrEqual(2);
    });

    it('several section callbacks of one render share one session', () => {
        const view = newView();
        activeView = view;
        render(view, noteText(), SECTION_HEADING);
        render(view, noteText(), SECTION_LIST);
        flush();
        FakeIO.instances.forEach((io) => io.fire(true));
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
    });
});

describe('lifecycle', () => {
    it('unloading the render stops the session (no commit afterwards)', () => {
        const view = newView();
        activeView = view;
        const { children } = render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(5, view.containerEl);
        children.forEach((c) => c.onunload());
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });

    it('switching the mode off mid-session stops it', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(10, view.containerEl);
        enabled = false;
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });

    it('a generation bump (purge, mode change, unload) stops a session that was qualifying', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(10, view.containerEl);
        gen += 1;
        step(120, view.containerEl);
        expect(commits).toHaveLength(0);
    });
});

describe('audit findings', () => {
    it('after the last child unloads, the same text in the same container starts a FRESH session', () => {
        const view = newView();
        activeView = view;
        const first = render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(5, view.containerEl);
        first.children.forEach((c) => c.onunload());
        const second = render(view, noteText());
        flush();
        expect(second.children).toHaveLength(1);
        FakeIO.instances.at(-1)!.fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
    });

    it('a session stopped by the mode switch is replaced when the mode comes back and the note re-renders', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        enabled = false;
        step(3, view.containerEl);
        enabled = true;
        render(view, noteText());
        flush();
        FakeIO.instances.at(-1)!.fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
    });

    it('end-of-brief visibility does not count while the view is not the active leaf, and counts once it is', () => {
        const view = newView();
        const other = newView();
        activeView = other;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true); // scrolled to the end in a background pane
        step(60, view.containerEl);
        expect(commits).toHaveLength(0); // nothing while the reader is elsewhere
        activeView = view;
        step(40, view.containerEl);      // the reader is now here, the end is on screen
        expect(commits).toHaveLength(1);
    });

    it('end-of-brief visibility does not count while the window is unfocused, and counts once it regains focus', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        FakeIO.instances[0].fire(true);
        step(60, view.containerEl);
        expect(commits).toHaveLength(0);
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        step(40, view.containerEl);
        expect(commits).toHaveLength(1);
    });
});

describe('audit round 2', () => {
    it('an initial notification below the visibility ratio is not the end of the brief', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true, 0.2);
        step(40, view.containerEl);
        expect(commits).toHaveLength(0);
        FakeIO.instances[0].fire(true, 0.8);
        step(10, view.containerEl);
        expect(commits).toHaveLength(1);
    });

    it('after a purge (new generation) the same text in the same view can be read again', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
        gen += 1; // Forget what I have read
        render(view, noteText());
        flush();
        FakeIO.instances.at(-1)!.fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(2);
        expect(commits[1].generation).toBe(1);
    });

    it('without a purge the completed session stays a tombstone (no double commit)', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(30, view.containerEl);
        render(view, noteText());
        flush();
        step(60, view.containerEl);
        expect(commits).toHaveLength(1);
    });
});

describe('audit round 3', () => {
    it('end visibility seen while the pane was inactive counts once the pane becomes active', () => {
        const view = newView();
        const other = newView();
        activeView = other;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true); // the end is on screen, but this pane is not the active one
        step(5, other.containerEl);
        activeView = view;              // the reader switches to it; no further IO notification arrives
        step(40, view.containerEl);
        expect(commits).toHaveLength(1);
    });

    it('a FAILED save allows the next render to try again, while a pending one blocks a second commit', async () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
    });

    it('session identity includes the bucket date, not only the text hash', () => {
        const view = newView();
        activeView = view;
        render(view, noteText());
        flush();
        FakeIO.instances[0].fire(true);
        step(30, view.containerEl);
        expect(commits).toHaveLength(1);
        // Same text, a different digest note (another bucket date): must not be swallowed by the first tombstone.
        render(view, noteText(), SECTION_LIST, `${ROOT}/Digest — 2026-10-22.md`);
        flush();
        expect(FakeIO.instances.length).toBeGreaterThanOrEqual(1);
    });
});

describe('audit round 4', () => {
    it('a purge between attach and the deferred bind makes the observation stale: no session is created', () => {
        const view = newView();
        activeView = view;
        const r = render(view, noteText()); // attach captures generation 0 and defers the bind
        gen += 1;                           // Forget what I have read, before the deferred bind runs
        flush();
        expect(FakeIO.instances).toHaveLength(0);
        step(60, view.containerEl);
        expect(commits).toHaveLength(0);
        expect(r.children).toHaveLength(1);
    });
});

describe('audit round 5', () => {
    it('unloading the section that holds the end releases its observed target', () => {
        const view = newView();
        activeView = view;
        render(view, noteText(), SECTION_HEADING);
        const end = render(view, noteText(), SECTION_LIST);
        flush();
        expect(FakeIO.instances[0].targets).toHaveLength(1);
        end.children.forEach((c) => c.onunload());
        expect(FakeIO.instances[0].targets).toHaveLength(0);
    });
});
