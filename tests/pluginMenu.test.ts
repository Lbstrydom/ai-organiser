/**
 * The one AI Organiser right-click section (docs/plans/navigation-discoverability.md, decision 6):
 * ordering and the cap, one render per menu instance, the desktop submenu, the mobile single
 * item, the fallback without a submenu API, and the coordinator owning the three events.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import {
    planMenuSection, renderPluginSection, registerPluginMenu, addMenuProvider, fileTarget, filesTarget,
    MENU_RANKED_CAP, MENU_SECTION, type MenuContribution, type MenuDeps,
} from '../src/ui/pluginMenu';

const c = (id: string, priority: 'cursor' | 'ranked' = 'ranked'): MenuContribution => ({ id, title: id, icon: 'x', priority, run: vi.fn() });

interface FakeItem { title: string; section?: string; icon?: string; click?: () => void; sub?: FakeMenu }
class FakeMenu {
    items: Array<FakeItem | 'separator'> = [];
    constructor(private readonly submenus = true) {}
    addItem(cb: (item: unknown) => void): this {
        const it: FakeItem = { title: '' };
        const api: Record<string, unknown> = {
            setTitle: (t: string) => { it.title = t; return api; },
            setIcon: (i: string) => { it.icon = i; return api; },
            setSection: (s: string) => { it.section = s; return api; },
            onClick: (fn: () => void) => { it.click = fn; return api; },
        };
        if (this.submenus) api.setSubmenu = () => { it.sub = new FakeMenu(); return it.sub; };
        cb(api);
        this.items.push(it);
        return this;
    }
    addSeparator(): this { this.items.push('separator'); return this; }
}
const labels = { title: 'AI organiser', mobileTitle: 'AI organiser…', more: 'More…' };
const titles = (m: FakeMenu) => m.items.map((i) => (i === 'separator' ? '—' : i.title));

describe('planMenuSection', () => {
    it('puts every cursor item first, then ranked items up to the cap, de-duplicated by id', () => {
        const out = planMenuSection([c('r1'), c('cur', 'cursor'), c('r2')], [c('r2'), c('r3'), c('r4'), c('r5')]);
        expect(out.map((x) => x.id)).toEqual(['cur', 'r1', 'r2', 'r3']);
        expect(out.filter((x) => x.priority === 'ranked')).toHaveLength(MENU_RANKED_CAP);
    });
    it('keeps every cursor item even past the cap (they are where the user clicked)', () => {
        const out = planMenuSection([c('a', 'cursor'), c('b', 'cursor'), c('c', 'cursor'), c('d', 'cursor')], [c('r1')]);
        expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'r1']);
    });
});

describe('renderPluginSection', () => {
    it('desktop: ONE "AI organiser" item whose submenu holds the items, a separator and More…', () => {
        const menu = new FakeMenu();
        const onMore = vi.fn();
        renderPluginSection(menu as never, [c('Transcribe audio')], labels, onMore, false);
        expect(titles(menu)).toEqual(['AI organiser']);
        const root = menu.items[0] as FakeItem;
        expect(root.section).toBe(MENU_SECTION);
        expect(titles(root.sub!)).toEqual(['Transcribe audio', '—', 'More…']);
        expect(root.sub!.items.filter((i) => i !== 'separator').length).toBeLessThanOrEqual(4);
        (root.sub!.items[2] as FakeItem).click!();
        expect(onMore).toHaveBeenCalled();
    });
    it('desktop with nothing to offer still shows More…', () => {
        const menu = new FakeMenu();
        renderPluginSection(menu as never, [], labels, vi.fn(), false);
        expect(titles((menu.items[0] as FakeItem).sub!)).toEqual(['More…']);
    });
    it('mobile: exactly one "AI organiser…" item that opens the scoped picker', () => {
        const menu = new FakeMenu();
        const onMore = vi.fn();
        renderPluginSection(menu as never, [c('a'), c('b')], labels, onMore, true);
        expect(titles(menu)).toEqual(['AI organiser…']);
        (menu.items[0] as FakeItem).click!();
        expect(onMore).toHaveBeenCalled();
    });
    it('renders once per menu instance, however many events reach it', () => {
        const menu = new FakeMenu();
        renderPluginSection(menu as never, [c('a')], labels, vi.fn(), false);
        renderPluginSection(menu as never, [c('a')], labels, vi.fn(), false);
        expect(titles(menu)).toEqual(['AI organiser']);
    });
    it('without a submenu API: the root opens the picker and the items follow in the same section', () => {
        const menu = new FakeMenu(false);
        const onMore = vi.fn();
        renderPluginSection(menu as never, [c('a'), c('b')], labels, onMore, false);
        expect(titles(menu)).toEqual(['AI organiser', 'a', 'b']);
        expect(menu.items.every((i) => i !== 'separator' && i.section === MENU_SECTION)).toBe(true);
        (menu.items[0] as FakeItem).click!();
        expect(onMore).toHaveBeenCalled();
    });
});

describe('the coordinator owns the three menu events', () => {
    function setup() {
        const handlers: Record<string, (...a: unknown[]) => void> = {};
        const plugin = {
            registerEvent: () => {},
            app: { workspace: { on: (name: string, fn: (...a: unknown[]) => void) => { handlers[name] = fn; return {}; } } },
        };
        const deps: MenuDeps = { rankedFor: () => [c('ranked-1'), c('ranked-2'), c('ranked-3'), c('ranked-4')], openScoped: vi.fn(), labels: () => labels, onError: vi.fn() };
        return { handlers, plugin, deps };
    }
    const file = (path: string, extension: string) => Object.assign(new TFile(), { path, extension, name: path });

    it('registers exactly file-menu, files-menu and editor-menu', () => {
        const { handlers, plugin, deps } = setup();
        registerPluginMenu(plugin as never, deps);
        expect(Object.keys(handlers).sort()).toEqual(['editor-menu', 'file-menu', 'files-menu']);
    });

    it('three providers contributing to the same menu yield ONE root and at most three ranked items plus More…', () => {
        const { handlers, plugin, deps } = setup();
        addMenuProvider(plugin, () => [c('p1')]);
        addMenuProvider(plugin, () => [c('p2'), c('p1')]);
        addMenuProvider(plugin, () => { throw new Error('a broken provider'); });
        registerPluginMenu(plugin as never, deps);
        const menu = new FakeMenu();
        handlers['file-menu'](menu, file('a.md', 'md'));
        expect(titles(menu)).toEqual(['AI organiser']);
        const sub = (menu.items[0] as FakeItem).sub!;
        expect(titles(sub)).toEqual(['p1', 'p2', 'ranked-1', '—', 'More…']);
        expect(deps.onError).toHaveBeenCalled();
    });

    it('a failing item is reported, not lost (sync throw and rejected promise)', async () => {
        const { handlers, plugin, deps } = setup();
        addMenuProvider(plugin, () => [
            { id: 'boom', title: 'boom', icon: 'x', priority: 'cursor', run: () => { throw new Error('sync'); } },
            { id: 'later', title: 'later', icon: 'x', priority: 'cursor', run: () => Promise.reject(new Error('async')) },
        ]);
        registerPluginMenu(plugin as never, { ...deps, rankedFor: () => [] });
        const menu = new FakeMenu();
        handlers['file-menu'](menu, file('a.md', 'md'));
        const sub = (menu.items[0] as FakeItem).sub!;
        (sub.items[0] as FakeItem).click!();
        (sub.items[1] as FakeItem).click!();
        await new Promise((r) => setTimeout(r, 0));
        expect(deps.onError).toHaveBeenCalledTimes(2);
    });

    it('More… passes the frozen target and every item, not only the capped ones', () => {
        const { handlers, plugin, deps } = setup();
        registerPluginMenu(plugin as never, deps);
        const menu = new FakeMenu();
        const f = file('Team sync.m4a', 'm4a');
        handlers['file-menu'](menu, f);
        const sub = (menu.items[0] as FakeItem).sub!;
        (sub.items[sub.items.length - 1] as FakeItem).click!();
        const [target, items] = (deps.openScoped as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(target).toEqual({ kind: 'file', file: f });
        expect((items as MenuContribution[]).length).toBe(4);
    });
});

describe('targets', () => {
    it('a folder (not the root), a file, and only a real multi-selection', () => {
        const folder = Object.assign(new TFolder(), { path: 'x', isRoot: () => false });
        const root = Object.assign(new TFolder(), { path: '', isRoot: () => true });
        expect(fileTarget(folder as never)?.kind).toBe('folder');
        expect(fileTarget(root as never)).toBeNull();
        expect(fileTarget(Object.assign(new TFile(), { path: 'a.md' }))?.kind).toBe('file');
        expect(filesTarget([Object.assign(new TFile(), { path: 'a.md' })])).toBeNull();
    });
});
