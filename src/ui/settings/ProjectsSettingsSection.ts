import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { captureOutputRoots } from '../../services/captureInbox/captureConfig';
import { PARA_KINDS, normaliseParaRoots, validateParaRoots, type ParaKind, type ParaRoot } from '../../services/projects/paraRoots';
import { peekProjectService } from '../../services/projects/projectService';
import { plural } from '../../utils/plural';

/**
 * Projects: the one PARA folder list that every project feature reads, and a one-line summary of what is adopted.
 * Setting a folder here moves nothing; it only tells features where the user keeps each kind of folder.
 */
export class ProjectsSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const c = this.plugin.t.projects;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'folder-kanban', 2);
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        const service = peekProjectService(this.plugin);
        if (service) {
            const index = service.index();
            const note = this.containerEl.createDiv({ cls: 'setting-item-description' });
            note.setText(`${plural(c.adoptedCount, index.projects.length)}${index.duplicates.size > 0 ? ' ' + plural(c.duplicateNote, index.duplicates.size) : ''}`);
        }

        new Setting(this.containerEl).setName(c.rootsName).setDesc(c.rootsDesc);
        const list = this.containerEl.createDiv({ cls: 'ai-organiser-para-roots' });
        const problems = this.containerEl.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning' });

        const save = (roots: ParaRoot[]): void => {
            s.paraRoots = normaliseParaRoots(roots);
            void this.plugin.saveSettings();
        };
        const showProblems = (roots: ParaRoot[]): void => {
            const folders = new Set(this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path));
            const found = validateParaRoots(normaliseParaRoots(roots), {
                existingFolders: folders,
                protectedFolders: s.protectedFolders,
                outputRoots: captureOutputRoots(s),
                inboxFolders: s.sweepInboxFolders,
            });
            problems.empty();
            for (const p of found) problems.createDiv({ text: c.rootProblems[p.code].replace('{path}', p.path).replace('{other}', 'other' in p ? p.other : '') });
        };
        // The rows are edited as a draft; only well-formed rows are stored, so a half-typed path is never saved.
        let draft: Array<{ path: string; kind: ParaKind }> = s.paraRoots.map((r) => ({ path: r.path, kind: r.kind }));
        const commit = (): void => {
            const roots = draft.map((d) => ({ path: d.path, kind: d.kind }));
            // Keep a Drive id a root already has when its row is edited.
            const merged = normaliseParaRoots(roots).map((r) => {
                const before = s.paraRoots.find((b) => b.path === r.path && b.kind === r.kind);
                return before?.driveRootId ? { ...r, driveRootId: before.driveRootId } : r;
            });
            save(merged);
            showProblems(merged);
        };
        const draw = (): void => {
            list.empty();
            if (draft.length === 0) list.createDiv({ text: c.rootsEmpty, cls: 'setting-item-description' });
            draft.forEach((row, i) => {
                new Setting(list)
                    .addDropdown((d) => {
                        for (const k of PARA_KINDS) d.addOption(k, c.rootKinds[k]);
                        d.setValue(row.kind).onChange((v) => { row.kind = v as ParaKind; commit(); });
                        d.selectEl.setAttribute('aria-label', c.rootKindLabel);
                    })
                    .addText((tx) => {
                        tx.setPlaceholder(c.rootPathLabel).setValue(row.path).onChange((v) => { row.path = v; commit(); });
                        tx.inputEl.setAttribute('aria-label', c.rootPathLabel);
                    })
                    .addExtraButton((b) => b.setIcon('trash').setTooltip(c.rootRemove).onClick(() => { draft = draft.filter((_, j) => j !== i); draw(); commit(); }));
            });
        };
        draw();
        showProblems(s.paraRoots);
        new Setting(this.containerEl).addButton((b) => b.setButtonText(c.rootAdd).onClick(() => { draft = [...draft, { path: '', kind: 'projects' }]; draw(); }));
    }
}
