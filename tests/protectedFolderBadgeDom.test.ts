// @vitest-environment happy-dom
/**
 * Protected-folder shield — the explorer controller (happy-dom). The explorer is synthetic markup
 * shaped like Obsidian's `.nav-folder-title[data-path]` rows; nothing here touches a real vault.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProtectedFolderBadge, type ProtectedFolderBadgeDeps } from '../src/ui/explorer/protectedFolderBadge';
import { PROTECTED_FOLDER_CLASS, PROTECTED_SHIELD_CLASS } from '../src/core/protectedFolderBadge';

const TOOLTIP = 'Protected by AI Organiser';

interface State { enabled: boolean; folders: string[]; containers: HTMLElement[] }

function makeTitle(path: string, name = path.split('/').pop() ?? path): HTMLElement {
    const folder = document.createElement('div');
    folder.className = 'nav-folder';
    const title = document.createElement('div');
    title.className = 'nav-folder-title';
    title.setAttribute('data-path', path);
    const content = document.createElement('div');
    content.className = 'nav-folder-title-content';
    content.textContent = name;
    title.appendChild(content);
    folder.appendChild(title);
    return folder;
}

function makeExplorer(paths: string[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'workspace-leaf-content';
    for (const p of paths) el.appendChild(makeTitle(p));
    document.body.appendChild(el);
    return el;
}

function setup(paths: string[], folders: string[], enabled = true) {
    const explorer = makeExplorer(paths);
    const state: State = { enabled, folders, containers: [explorer] };
    const deps: ProtectedFolderBadgeDeps = {
        getContainers: () => state.containers,
        getState: () => ({ enabled: state.enabled, folders: state.folders }),
        getTooltip: () => TOOLTIP,
    };
    const badge = new ProtectedFolderBadge(deps);
    return { explorer, state, badge };
}

const title = (root: HTMLElement, path: string): HTMLElement =>
    root.querySelector(`.nav-folder-title[data-path="${path}"]`) as HTMLElement;
const shields = (root: HTMLElement): NodeListOf<Element> => root.querySelectorAll(`.${PROTECTED_SHIELD_CLASS}`);
const tagged = (root: HTMLElement): NodeListOf<Element> => root.querySelectorAll(`.${PROTECTED_FOLDER_CLASS}`);
/** Let MutationObserver callbacks run (microtask or macrotask, whichever the DOM implementation uses). */
const flush = async (): Promise<void> => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tagging', () => {
    it('shields exactly the protected roots, with an accessible name', () => {
        const { explorer, badge } = setup(['Course', 'Course/Alpha', 'Course/AlphaBeta', 'Other'], ['Course/Alpha']);
        badge.refresh();
        expect(tagged(explorer).length).toBe(1);
        const t = title(explorer, 'Course/Alpha');
        expect(t.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        const shield = t.querySelector(`.${PROTECTED_SHIELD_CLASS}`)!;
        expect(shield.getAttribute('role')).toBe('img');
        expect(shield.getAttribute('aria-label')).toBe(TOOLTIP);
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });

    it('matches case-insensitively, like the write guards', () => {
        const { explorer, badge } = setup(['course/alpha'], ['Course/ALPHA/']);
        badge.refresh();
        expect(tagged(explorer).length).toBe(1);
        badge.dispose();
    });

    it('does not shield descendants or the vault root', () => {
        const { explorer, badge } = setup(['/', 'Course/Alpha/Week 1'], ['Course/Alpha']);
        badge.refresh();
        expect(tagged(explorer).length).toBe(0);
        badge.dispose();
    });

    it('is idempotent: a second pass changes nothing', () => {
        vi.useFakeTimers();
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        const before = explorer.innerHTML;
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(explorer.innerHTML).toBe(before);
        badge.dispose();
    });

    it('leaves attributes and classes it does not own untouched', () => {
        const { explorer, badge } = setup(['A'], ['A']);
        const t = title(explorer, 'A');
        t.classList.add('is-active', 'theme-class');
        t.setAttribute('aria-label', 'theme tooltip');
        badge.refresh();
        expect(t.getAttribute('aria-label')).toBe('theme tooltip');
        badge.dispose();
        expect(t.classList.contains('is-active')).toBe(true);
        expect(t.classList.contains('theme-class')).toBe(true);
        expect(t.getAttribute('aria-label')).toBe('theme tooltip');
    });
});

describe('staying correct', () => {
    it('shields a protected folder that appears on expand, before any timer fires', async () => {
        vi.useFakeTimers();
        const { explorer, badge } = setup(['Course'], ['Course/Alpha']);
        badge.refresh();
        expect(tagged(explorer).length).toBe(0);
        const timersBefore = vi.getTimerCount();

        explorer.appendChild(makeTitle('Course/Alpha'));
        await vi.advanceTimersByTimeAsync(0);
        expect(tagged(explorer).length).toBe(1);

        // a second expansion in a later turn, still without advancing the throttle window
        explorer.appendChild(makeTitle('Course/Alpha2'));
        explorer.appendChild(makeTitle('Course/Alpha'));
        await vi.advanceTimersByTimeAsync(0);
        expect(tagged(explorer).length).toBe(2);
        expect(vi.getTimerCount()).toBe(timersBefore);
        badge.dispose();
    });

    it('decorates a subtree added in one mutation', async () => {
        const { explorer, badge } = setup([], ['A/B']);
        badge.refresh();
        const wrapper = document.createElement('div');
        wrapper.appendChild(makeTitle('A'));
        wrapper.appendChild(makeTitle('A/B'));
        explorer.appendChild(wrapper);
        await flush();
        expect(tagged(explorer).length).toBe(1);
        expect(title(explorer, 'A/B').classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        badge.dispose();
    });

    it('follows a rename that changes data-path in place', async () => {
        const { explorer, state, badge } = setup(['Course/Alpha'], ['Course/Alpha']);
        badge.refresh();
        const t = title(explorer, 'Course/Alpha');
        // Obsidian moves the folder: the live list is remapped, then the row's data-path changes.
        state.folders = ['Course/Alpha 2'];
        t.setAttribute('data-path', 'Course/Alpha 2');
        await flush();
        expect(t.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        expect(shields(explorer).length).toBe(1);

        t.setAttribute('data-path', 'Course/Elsewhere');
        await flush();
        expect(t.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(false);
        expect(shields(explorer).length).toBe(0);
        badge.dispose();
    });

    it('cleans a decorated row whose data-path attribute is removed', async () => {
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        const t = title(explorer, 'A');
        t.removeAttribute('data-path');
        await flush();
        expect(t.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(false);
        expect(shields(t).length).toBe(0);
        badge.dispose();
    });

    it('restores the shield when a title children are replaced under the same data-path', async () => {
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        const t = title(explorer, 'A');
        t.replaceChildren(Object.assign(document.createElement('div'), { className: 'nav-folder-title-content', textContent: 'A' }));
        await flush();
        expect(shields(explorer).length).toBe(1);
        expect(t.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        badge.dispose();
    });

    it('cleans a row the moment it leaves the explorer, without a full pass', async () => {
        const { explorer, badge } = setup(['A', 'B'], ['A']);
        badge.refresh();
        const row = title(explorer, 'A');
        row.parentElement!.remove();
        await flush();
        expect(row.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(false);
        expect(shields(row).length).toBe(0);
        badge.dispose();
    });

    it('a row moved within the explorer keeps exactly one shield', async () => {
        const { explorer, badge } = setup(['A', 'B'], ['A']);
        badge.refresh();
        const folder = title(explorer, 'A').parentElement!;
        explorer.appendChild(folder);
        await flush();
        expect(shields(explorer).length).toBe(1);
        expect(title(explorer, 'A').classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        badge.dispose();
    });

    it('restores exactly one shield when only the shield is removed', async () => {
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        shields(explorer)[0].remove();
        await flush();
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });

    it('leaves an unprotected title bare when its children are replaced', async () => {
        const { explorer, badge } = setup(['A', 'B'], ['A']);
        badge.refresh();
        title(explorer, 'B').replaceChildren(document.createElement('span'));
        await flush();
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });

    it('does not loop on its own edits', async () => {
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        await flush();
        const html = explorer.innerHTML;
        await flush();
        await flush();
        expect(explorer.innerHTML).toBe(html);
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });

    it('adds and removes shields when the protected list changes', () => {
        vi.useFakeTimers();
        const { explorer, state, badge } = setup(['A', 'B'], ['A']);
        badge.refresh();
        expect(tagged(explorer).length).toBe(1);

        state.folders = ['A', 'B'];
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(tagged(explorer).length).toBe(2);

        state.folders = ['B'];
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(tagged(explorer).length).toBe(1);
        expect(title(explorer, 'B').classList.contains(PROTECTED_FOLDER_CLASS)).toBe(true);
        badge.dispose();
    });

    it('removes everything when the toggle turns off, and restores it when it turns on', () => {
        vi.useFakeTimers();
        const { explorer, state, badge } = setup(['A'], ['A']);
        badge.refresh();
        state.enabled = false;
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(tagged(explorer).length).toBe(0);
        expect(shields(explorer).length).toBe(0);
        state.enabled = true;
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(tagged(explorer).length).toBe(1);
        badge.dispose();
    });

    it('picks up an explorer opened late', () => {
        vi.useFakeTimers();
        const { state, badge } = setup([], ['A']);
        state.containers = [];
        badge.refresh();
        const late = makeExplorer(['A', 'B']);
        state.containers = [late];
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(tagged(late).length).toBe(1);
        badge.dispose();
    });

    it('refreshes the tooltip text when it changes', () => {
        vi.useFakeTimers();
        let tip = 'one';
        const explorer = makeExplorer(['A']);
        const badge = new ProtectedFolderBadge({
            getContainers: () => [explorer],
            getState: () => ({ enabled: true, folders: ['A'] }),
            getTooltip: () => tip,
        });
        badge.refresh();
        tip = 'two';
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(shields(explorer)[0].getAttribute('aria-label')).toBe('two');
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });
});

describe('container lifecycle', () => {
    it('cleans and stops watching an explorer that was closed', async () => {
        vi.useFakeTimers();
        const { explorer, state, badge } = setup(['A'], ['A']);
        badge.refresh();
        expect(shields(explorer).length).toBe(1);
        state.containers = [];
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(shields(explorer).length).toBe(0);
        expect(tagged(explorer).length).toBe(0);
        // a later mutation in the retired container is ignored
        explorer.appendChild(makeTitle('A'));
        await vi.advanceTimersByTimeAsync(0);
        expect(tagged(explorer).length).toBe(0);
        badge.dispose();
    });

    it('cleans a container that was detached with tagged rows still inside', () => {
        vi.useFakeTimers();
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        const row = title(explorer, 'A');
        explorer.remove(); // the leaf went away without a clean unmount
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(row.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(false);
        expect(row.querySelector(`.${PROTECTED_SHIELD_CLASS}`)).toBeNull();
        badge.dispose();
    });

    it('cleans rows that left the DOM before the next pass', () => {
        vi.useFakeTimers();
        const { explorer, badge } = setup(['A'], ['A']);
        badge.refresh();
        const row = title(explorer, 'A');
        row.parentElement!.remove();
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(row.classList.contains(PROTECTED_FOLDER_CLASS)).toBe(false);
        expect(shields(row)).toHaveLength(0);
        badge.dispose();
    });

    it('watches several explorers independently', () => {
        const a = makeExplorer(['A']);
        const b = makeExplorer(['A', 'B']);
        const badge = new ProtectedFolderBadge({
            getContainers: () => [a, b],
            getState: () => ({ enabled: true, folders: ['A'] }),
            getTooltip: () => TOOLTIP,
        });
        badge.refresh();
        expect(tagged(a).length).toBe(1);
        expect(tagged(b).length).toBe(1);
        badge.dispose();
        expect(tagged(a).length + tagged(b).length).toBe(0);
    });
});

describe('throttling of full passes', () => {
    it('runs the first pass at once and coalesces a burst into one trailing pass', () => {
        vi.useFakeTimers();
        let reads = 0;
        const explorer = makeExplorer(['A']);
        const badge = new ProtectedFolderBadge({
            getContainers: () => { reads++; return [explorer]; },
            getState: () => ({ enabled: true, folders: ['A'] }),
            getTooltip: () => TOOLTIP,
        });
        badge.refresh();
        expect(reads).toBe(1);
        for (let i = 0; i < 10; i++) badge.refresh();
        expect(reads).toBe(1);
        vi.advanceTimersByTime(100);
        expect(reads).toBe(2);
        vi.advanceTimersByTime(500);
        expect(reads).toBe(2);
        badge.dispose();
    });

    it('a small batch is handled incrementally; a batch above the limit does exactly one full pass', async () => {
        const proto = ProtectedFolderBadge.prototype as unknown as { fullPass(c: HTMLElement): void };
        const { explorer, badge } = setup([], ['A']);
        badge.refresh();
        const fullPass = vi.spyOn(proto, 'fullPass');

        explorer.appendChild(makeTitle('A'));
        await flush();
        expect(tagged(explorer).length).toBe(1);
        expect(fullPass).not.toHaveBeenCalled();

        const wrapper = document.createElement('div');
        wrapper.appendChild(makeTitle('A'));
        explorer.appendChild(wrapper);
        for (let i = 0; i < 600; i++) explorer.appendChild(document.createElement('i'));
        await flush();
        expect(tagged(explorer).length).toBe(2);
        expect(fullPass).toHaveBeenCalledTimes(1);
        badge.dispose();
    });
});

describe('inert and off paths', () => {
    function spyObserver() {
        const Original = globalThis.MutationObserver;
        const ctor = vi.fn(function (this: unknown, cb: MutationCallback) { return new Original(cb); });
        vi.stubGlobal('MutationObserver', ctor);
        return ctor;
    }

    it('with an empty protected list: byte-identical DOM, no observer, no timer', async () => {
        vi.useFakeTimers();
        const ctor = spyObserver();
        const { explorer, badge } = setup(['A', 'B', 'C/D'], []);
        const before = explorer.innerHTML;
        badge.refresh();
        badge.refresh();
        await vi.advanceTimersByTimeAsync(500);
        expect(explorer.innerHTML).toBe(before);
        expect(ctor).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        badge.dispose();
        expect(explorer.innerHTML).toBe(before);
        vi.unstubAllGlobals();
    });

    it('with the toggle off and a non-empty list: byte-identical DOM, no observer, no timer', async () => {
        vi.useFakeTimers();
        const ctor = spyObserver();
        const { explorer, badge } = setup(['A', 'B'], ['A'], false);
        const before = explorer.innerHTML;
        badge.refresh();
        await vi.advanceTimersByTimeAsync(500);
        expect(explorer.innerHTML).toBe(before);
        expect(ctor).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        badge.dispose();
        vi.unstubAllGlobals();
    });

    it('turning the toggle off on an active controller leaves the original markup', () => {
        vi.useFakeTimers();
        const { explorer, state, badge } = setup(['A', 'B'], ['A']);
        const before = explorer.innerHTML;
        badge.refresh();
        expect(explorer.innerHTML).not.toBe(before);
        state.enabled = false;
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(explorer.innerHTML).toBe(before);
        badge.dispose();
    });
});

describe('dispose', () => {
    it('removes everything, stops observing and ignores later calls', async () => {
        vi.useFakeTimers();
        const { explorer, badge } = setup(['A'], ['A']);
        const before = explorer.innerHTML;
        badge.refresh();
        badge.dispose();
        expect(explorer.innerHTML).not.toContain(PROTECTED_SHIELD_CLASS);
        expect(tagged(explorer).length).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        explorer.appendChild(makeTitle('A'));
        await vi.advanceTimersByTimeAsync(500);
        badge.refresh();
        expect(tagged(explorer).length).toBe(0);
        expect(explorer.innerHTML).not.toBe(before); // only the node this test added
        expect(shields(explorer).length).toBe(0);
        badge.dispose(); // twice is safe
    });
});

describe('failure', () => {
    it('a throwing dependency never escapes', () => {
        const badge = new ProtectedFolderBadge({
            getContainers: () => { throw new Error('boom'); },
            getState: () => ({ enabled: true, folders: ['A'] }),
            getTooltip: () => TOOLTIP,
        });
        expect(() => badge.refresh()).not.toThrow();
        badge.dispose();
    });

    it('a pass that fails half-way clears every shield instead of leaving stale ones', () => {
        vi.useFakeTimers();
        const { explorer, state, badge } = setup(['A'], ['A']);
        badge.refresh();
        expect(shields(explorer).length).toBe(1);
        const explode = vi.fn(() => { throw new Error('boom'); });
        state.containers = { filter: explode } as unknown as HTMLElement[];
        vi.advanceTimersByTime(200);
        expect(() => badge.refresh()).not.toThrow();
        expect(explode).toHaveBeenCalled();
        expect(shields(explorer).length).toBe(0);
        expect(tagged(explorer).length).toBe(0);
        // the controller stays usable: the next healthy refresh rebuilds
        state.containers = [explorer];
        vi.advanceTimersByTime(200);
        badge.refresh();
        expect(shields(explorer).length).toBe(1);
        badge.dispose();
    });

    it('a failing observer batch clears the shields too', async () => {
        const { explorer, state, badge } = setup(['A'], ['A']);
        badge.refresh();
        expect(shields(explorer).length).toBe(1);
        state.enabled = true;
        const original = state.folders;
        Object.defineProperty(state, 'folders', { get() { throw new Error('boom'); }, configurable: true });
        explorer.appendChild(makeTitle('A'));
        await flush();
        expect(shields(explorer).length).toBe(0);
        Object.defineProperty(state, 'folders', { value: original, configurable: true, writable: true });
        badge.dispose();
    });
});
