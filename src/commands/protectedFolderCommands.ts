/**
 * Protected folders (F1): wiring between the pure core (`core/protectedPaths.ts`) and Obsidian.
 *
 * - installs the live list for seams that never receive settings (tag / frontmatter writers);
 * - keeps protection attached to a folder when Obsidian renames or moves it;
 * - adds "Protect this folder" / "Stop protecting this folder" to the file explorer menu;
 * - validates that no plugin output folder ends up inside a protected folder;
 * - hosts the guided setup (choose folders → check and confirm).
 *
 * Nothing here registers a command-palette entry: with an empty list the feature is inert.
 */
import { MarkdownView, Menu, Notice, TAbstractFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok, err } from '../core/result';
import {
    findOutputRootConflicts,
    normalisePath,
    resolveProtectedFolders,
    rewriteOnRename,
    setActiveProtection,
    type OutputRootConflict,
} from '../core/protectedPaths';
import { getPluginManagedFolders, OUTPUT_ROOT_SETTING_KEYS } from '../core/settings';
import { GuidedSetupModal } from '../ui/modals/GuidedSetupModal';
import { FolderListEditor, countNotesInFolder } from '../ui/setup/FolderListEditor';
import { logger } from '../utils/logger';
import { installActiveNoteGuard } from '../utils/protectedGuard';

/** Output folders (plugin-managed) that collide with the given protected list. */
export function outputConflicts(plugin: AIOrganiserPlugin, protectedFolders: readonly string[]): OutputRootConflict[] {
    const roots = getPluginManagedFolders(plugin.settings).map((path, i) => ({ label: path || `output ${i + 1}`, path }));
    return findOutputRootConflicts(protectedFolders, roots);
}

/**
 * Save a new protected list. Refused (nothing changes) when a plugin output folder would end up
 * inside a protected folder or the other way round; the error text names the folder.
 */
export async function applyProtectedFolders(plugin: AIOrganiserPlugin, next: readonly string[]): Promise<Result<void>> {
    const list = resolveProtectedFolders(next);
    const conflicts = outputConflicts(plugin, list);
    if (conflicts.length > 0) {
        return err(plugin.t.protectedFolders.outputRefused.replace('{label}', conflicts[0].label));
    }
    plugin.settings.protectedFolders = list;
    await plugin.saveSettings();
    return ok(undefined);
}

// ── Output-folder disjointness at every settings save ──────────────────────────────────────────
// The last state in which no NEW collision existed. A save that introduces a collision restores
// the output-folder settings from here, so the rule holds for output-folder edits as well as for
// protected-list edits. A collision that already existed when the plugin loaded is only warned
// about (the user may be mid-migration); it never grows.
let lastGoodOutputRoots: Record<string, unknown> = {};
let knownConflictPaths = new Set<string>();
let baselined = false;

function snapshotOutputRoots(settings: object): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of OUTPUT_ROOT_SETTING_KEYS) out[key] = (settings as Record<string, unknown>)[key];
    return out;
}

/**
 * Call at the start of every settings save. Returns true when a change was reverted because it
 * would have put a plugin output folder inside (or around) a protected folder.
 */
export function enforceOutputDisjointness(plugin: AIOrganiserPlugin): boolean {
    const conflicts = outputConflicts(plugin, plugin.settings.protectedFolders);
    if (!baselined) {
        // A save before registration (during load) establishes the starting state; nothing to revert.
        lastGoodOutputRoots = snapshotOutputRoots(plugin.settings);
        knownConflictPaths = new Set(conflicts.map((c) => c.path));
        baselined = true;
        return false;
    }
    const introduced = conflicts.filter((c) => !knownConflictPaths.has(c.path));
    if (introduced.length === 0) {
        lastGoodOutputRoots = snapshotOutputRoots(plugin.settings);
        knownConflictPaths = new Set(conflicts.map((c) => c.path));
        return false;
    }
    Object.assign(plugin.settings, lastGoodOutputRoots);
    new Notice(plugin.t.protectedFolders.outputRefused.replace('{label}', introduced[0].label), 10000);
    plugin.settingTab?.display();
    return true;
}

/** Record the starting state and warn once about a collision that already exists. */
function warnAboutOverlap(plugin: AIOrganiserPlugin): void {
    const conflicts = outputConflicts(plugin, plugin.settings.protectedFolders);
    lastGoodOutputRoots = snapshotOutputRoots(plugin.settings);
    knownConflictPaths = new Set(conflicts.map((c) => c.path));
    baselined = true;
    for (const c of conflicts) {
        logger.warn('Protected', `Output folder "${c.label}" overlaps protected folder "${c.protectedFolder}"`);
        new Notice(plugin.t.protectedFolders.outputOverlap.replace('{label}', c.label), 10000);
    }
}

/** The guided setup: pick folders, then check and confirm. Settings are written once, at Finish. */
export function openProtectedFoldersSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    let draft = [...plugin.settings.protectedFolders];
    new GuidedSetupModal(plugin.app, t, {
        title: t.protectedFolders.wizardTitle,
        steps: [
            {
                id: 'choose',
                title: t.protectedFolders.wizardChooseTitle,
                render: (el) => {
                    el.createEl('p', { text: t.protectedFolders.wizardChooseHelp });
                    new FolderListEditor({
                        app: plugin.app,
                        container: el,
                        t,
                        getFolders: () => draft,
                        emptyText: t.protectedFolders.empty,
                        onChange: (next) => { draft = [...next]; },
                    }).render();
                },
            },
            {
                id: 'confirm',
                title: t.protectedFolders.wizardConfirmTitle,
                render: (el) => {
                    if (draft.length === 0) {
                        el.createEl('p', { text: t.protectedFolders.wizardNothingChosen });
                        return;
                    }
                    const notes = draft.reduce((sum, f) => sum + countNotesInFolder(plugin.app, f), 0);
                    el.createEl('p', {
                        text: t.protectedFolders.wizardConfirmSummary
                            .replace('{count}', String(notes))
                            .replace('{folders}', String(draft.length)),
                    });
                    const list = el.createEl('ul');
                    for (const f of draft) list.createEl('li', { text: f });
                },
            },
        ],
        onFinish: async () => {
            const res = await applyProtectedFolders(plugin, draft);
            if (!res.ok) {
                new Notice(res.error, 8000);
                return err('output-overlap');
            }
            plugin.settings.featureSetupCompletedAt['protected-folders'] = new Date().toISOString();
            await plugin.saveSettings();
            onDone?.();
            return ok(undefined);
        },
    }).open();
}

function addMenuItems(plugin: AIOrganiserPlugin, menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFolder) || file.isRoot()) return;
    const t = plugin.t.protectedFolders;
    const already = plugin.settings.protectedFolders.some((f) => normalisePath(f).toLowerCase() === normalisePath(file.path).toLowerCase());
    menu.addItem((item) => item
        .setTitle(already ? t.unprotectAction : t.protectAction)
        .setIcon('shield')
        .onClick(() => {
            void (async () => {
                if (already) {
                    const next = plugin.settings.protectedFolders.filter((f) => normalisePath(f).toLowerCase() !== normalisePath(file.path).toLowerCase());
                    await applyProtectedFolders(plugin, next);
                    new Notice(t.noLongerProtected.replace('{folder}', file.path), 4000);
                    return;
                }
                const res = await applyProtectedFolders(plugin, [...plugin.settings.protectedFolders, file.path]);
                if (!res.ok) {
                    new Notice(res.error, 8000);
                    return;
                }
                new Notice(
                    t.nowProtected.replace('{folder}', file.path).replace('{count}', String(countNotesInFolder(plugin.app, file.path))),
                    5000,
                );
            })();
        }));
}

/** Install everything. Called once from onload, after settings are loaded. */
export function registerProtectedFolders(plugin: AIOrganiserPlugin): void {
    setActiveProtection(() => plugin.settings);
    installActiveNoteGuard(
        () => plugin.app.workspace.getActiveFile()?.path ?? null,
        () => plugin.t.messages.protectedNoteNotModified,
        (editor) => {
            for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
                const view = leaf.view;
                if (view instanceof MarkdownView && view.editor === editor) return view.file?.path ?? null;
            }
            return null;
        },
    );

    plugin.registerEvent(plugin.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFolder)) return;
        const res = rewriteOnRename(plugin.settings.protectedFolders, oldPath, file.path);
        if (!res.changed) return;
        plugin.settings.protectedFolders = res.list;
        void plugin.saveSettings();
    }));

    plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => addMenuItems(plugin, menu, file)));

    warnAboutOverlap(plugin);
}

/** Tear down the registry (onunload). */
export function unregisterProtectedFolders(): void {
    baselined = false;
    setActiveProtection(null);
    installActiveNoteGuard(null, null);
}
