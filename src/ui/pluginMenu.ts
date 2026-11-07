/**
 * One "AI Organiser" section in every right-click menu (docs/plans/navigation-discoverability.md,
 * decision 6).
 *
 * One owner per menu event: this module registers the only `file-menu`, `files-menu` and
 * `editor-menu` handlers. Feature modules register CONTRIBUTION PROVIDERS instead of menu
 * items, so a feature that is off contributes nothing (its registrar never runs). For each menu
 * the coordinator collects every provider's contributions, de-duplicates them by id, keeps the
 * cursor-specific ones first (edit diagram, digitise, highlight, quick peek on a source), fills
 * up to three with ranked actions for the target, and renders the section once.
 *
 * Desktop: one "AI Organiser" item with a submenu (items, a separator, "More…" opening the
 * picker scoped to the target). Mobile: one "AI Organiser…" item opening that picker, whose
 * "For this context" section lists the same items.
 */
import { Menu, MenuItem, Platform, TFile, TFolder, type Editor, type EventRef, type MarkdownFileInfo, type MarkdownView, type TAbstractFile, type Workspace } from 'obsidian';

export type MenuTarget =
    | { readonly kind: 'file'; readonly file: TFile }
    | { readonly kind: 'folder'; readonly folder: TFolder }
    | { readonly kind: 'files'; readonly files: readonly TFile[] }
    | { readonly kind: 'editor'; readonly file: TFile | null; readonly editor: Editor; readonly selection: string };

export interface MenuContribution {
    /** Stable id; contributions with the same id appear once. Usually the action id. */
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    /** 'cursor' items are specific to where the user clicked and always come first. */
    readonly priority: 'cursor' | 'ranked';
    readonly run: () => void;
}

export type MenuProvider = (target: MenuTarget) => readonly MenuContribution[];

/** Ranked items shown on desktop, after every cursor item, before "More…". */
export const MENU_RANKED_CAP = 3;
export const MENU_SECTION = 'ai-organiser';

const providersByPlugin = new WeakMap<object, MenuProvider[]>();

/** Called by a feature's registrar (so only while the feature is on). */
export function addMenuProvider(plugin: object, provider: MenuProvider): void {
    const list = providersByPlugin.get(plugin) ?? [];
    list.push(provider);
    providersByPlugin.set(plugin, list);
}

export function menuProviders(plugin: object): readonly MenuProvider[] {
    return providersByPlugin.get(plugin) ?? [];
}

/**
 * Pure: the items of one section, in order. Cursor items first (all of them, de-duplicated),
 * then ranked items up to the cap, never one that is already listed.
 */
export function planMenuSection(
    contributions: readonly MenuContribution[],
    ranked: readonly MenuContribution[],
    cap = MENU_RANKED_CAP,
): MenuContribution[] {
    const seen = new Set<string>();
    const out: MenuContribution[] = [];
    const take = (c: MenuContribution): void => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
    contributions.filter((c) => c.priority === 'cursor').forEach(take);
    let rankedCount = 0;
    for (const c of [...contributions.filter((x) => x.priority === 'ranked'), ...ranked]) {
        if (rankedCount >= cap) break;
        if (seen.has(c.id)) continue;
        take(c);
        rankedCount++;
    }
    return out;
}

interface SubmenuCapable { setSubmenu?: () => Menu }

export interface SectionLabels {
    readonly title: string;
    readonly mobileTitle: string;
    readonly more: string;
}

/**
 * Render the section on one menu instance, once. A `WeakSet` guards against a second render
 * when Obsidian fires two of our events for the same menu.
 */
const rendered = new WeakSet<Menu>();
export function renderPluginSection(
    menu: Menu,
    items: readonly MenuContribution[],
    labels: SectionLabels,
    onMore: () => void,
    isMobile: boolean = Platform.isMobile,
): void {
    if (rendered.has(menu)) return;
    rendered.add(menu);
    if (isMobile) {
        menu.addItem((item) => item.setSection(MENU_SECTION).setTitle(labels.mobileTitle).setIcon('ai-organiser').onClick(onMore));
        return;
    }
    let flat = false;
    menu.addItem((item: MenuItem) => {
        item.setSection(MENU_SECTION).setTitle(labels.title).setIcon('ai-organiser');
        const sub = (item as unknown as SubmenuCapable).setSubmenu?.();
        if (sub) {
            for (const c of items) sub.addItem((i) => i.setTitle(c.title).setIcon(c.icon).onClick(c.run));
            if (items.length > 0) sub.addSeparator();
            sub.addItem((i) => i.setTitle(labels.more).setIcon('more-horizontal').onClick(onMore));
        } else {
            // No submenu API: the item itself opens the scoped picker, and the items follow
            // it flat in the same section (added below, after this root).
            item.onClick(onMore);
            flat = true;
        }
    });
    if (flat) for (const c of items) menu.addItem((i) => i.setSection(MENU_SECTION).setTitle(c.title).setIcon(c.icon).onClick(c.run));
}

/** Build the target from what Obsidian passes to each event. */
export function fileTarget(file: TAbstractFile): MenuTarget | null {
    if (file instanceof TFolder) return file.isRoot() ? null : { kind: 'folder', folder: file };
    if (file instanceof TFile) return { kind: 'file', file };
    return null;
}

export function filesTarget(files: readonly TAbstractFile[]): MenuTarget | null {
    const onlyFiles = files.filter((f): f is TFile => f instanceof TFile);
    return onlyFiles.length > 1 ? { kind: 'files', files: onlyFiles } : null;
}

/** Every provider's contributions for one target; a throwing provider is skipped, not fatal. */
export function collectContributions(providers: readonly MenuProvider[], target: MenuTarget, onError: (e: unknown) => void): MenuContribution[] {
    const out: MenuContribution[] = [];
    for (const p of providers) {
        try { out.push(...p(target)); } catch (e) { onError(e); }
    }
    return out;
}

// ── The coordinator: the only handlers of the three menu events ──────────────────────────

export interface MenuDeps {
    /** Ranked registry actions for a target (ready, accepting the target), already capped. */
    rankedFor: (target: MenuTarget) => MenuContribution[];
    /** Open the picker scoped to the target, listing these items under "For this context". */
    openScoped: (target: MenuTarget, items: readonly MenuContribution[]) => void;
    labels: () => SectionLabels;
    onError: (e: unknown) => void;
}

function showSection(plugin: object, menu: Menu, target: MenuTarget | null, deps: MenuDeps): void {
    if (!target) return;
    const contributions = collectContributions(menuProviders(plugin), target, deps.onError);
    let ranked: MenuContribution[] = [];
    try { ranked = deps.rankedFor(target); } catch (e) { deps.onError(e); }
    const items = planMenuSection(contributions, ranked);
    // The scoped picker lists every contribution, not only the capped few.
    const all = planMenuSection(contributions, ranked, Number.MAX_SAFE_INTEGER);
    renderPluginSection(menu, items, deps.labels(), () => deps.openScoped(target, all));
}

/** Register the three menu events once. Feature modules call `addMenuProvider` instead. */
export function registerPluginMenu(
    plugin: { registerEvent: (ref: EventRef) => void; app: { workspace: Workspace } },
    deps: MenuDeps,
): void {
    const ws = plugin.app.workspace;
    plugin.registerEvent(ws.on('file-menu', (menu: Menu, file: TAbstractFile) => showSection(plugin, menu, fileTarget(file), deps)));
    plugin.registerEvent(ws.on('files-menu', (menu: Menu, files: TAbstractFile[]) => showSection(plugin, menu, filesTarget(files), deps)));
    plugin.registerEvent(ws.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const file = info.file instanceof TFile ? info.file : null;
        showSection(plugin, menu, { kind: 'editor', file, editor, selection: editor.getSelection() }, deps);
    }));
}

/** The name the picker header shows for a target ("For: Team sync.m4a"). */
export function targetLabel(target: MenuTarget): string {
    if (target.kind === 'file') return target.file.name;
    if (target.kind === 'folder') return target.folder.name;
    if (target.kind === 'files') return String(target.files.length);
    return target.file?.name ?? '';
}
