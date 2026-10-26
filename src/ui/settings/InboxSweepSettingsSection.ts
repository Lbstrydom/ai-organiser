import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { openInboxSweepSetup, runInboxSweep, sweepBlocker } from '../../commands/inboxSweepCommands';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { contextProblems, normaliseContexts } from '../../services/inboxSweep/sweepContexts';

/**
 * Inbox sweep settings: a status row, a plain summary of what is swept and what is kept out, the
 * two buttons, and one collapsed Advanced group for the limits. Folder and rule editing happens in
 * the guided setup, so a person never edits a list of rules in a settings file.
 */
export class InboxSweepSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    /** The contexts the sweep offers: one per line, validated as the user types; empty means the built-in set. */
    private renderContexts(parent: HTMLElement): void {
        const c = this.plugin.t.inboxSweep;
        const s = this.plugin.settings;
        const setting = new Setting(parent).setName(c.contextsName).setDesc(c.contextsDesc);
        const problem = parent.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning' });
        problem.hide();
        let area: HTMLTextAreaElement | null = null;
        const showProblems = (raw: string): void => {
            const dropped = contextProblems(raw).map((p) => p.line);
            if (dropped.length === 0) { problem.hide(); return; }
            problem.setText(c.contextsDropped.replace('{lines}', dropped.join(', ')));
            problem.show();
        };
        setting.addTextArea((ta) => {
            area = ta.inputEl;
            ta.inputEl.rows = 4;
            ta.setValue(s.sweepContexts.join('\n')).onChange((v) => {
                showProblems(v);
                s.sweepContexts = normaliseContexts(v);
                void this.plugin.saveSettings();
            });
        });
        setting.addButton((b) => b.setButtonText(c.contextsReset).onClick(() => {
            s.sweepContexts = [];
            if (area) area.value = '';
            problem.hide();
            void this.plugin.saveSettings();
        }));
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.inboxSweep;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'inbox', 2);

        const folders = this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path);
        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: c.statusName,
            evaluation: evaluateSetup('inbox-sweep', s, { existingFolders: toFolderSet(folders) }),
            onOpen: () => openInboxSweepSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        const rules = s.sweepExcludedFolders.length + s.sweepExcludedTags.length + s.sweepExcludedProperties.length + s.sweepExcludedTerms.length;
        this.containerEl.createDiv({ cls: 'setting-item-description', text: `${s.sweepInboxFolders.join(', ') || '—'} · ${c.keepOutSummary.replace('{count}', String(rules))}` });
        const blocker = sweepBlocker(this.plugin);
        if (blocker) this.containerEl.createDiv({ cls: 'setting-item-description', text: formatGuidance(describeError(t, blocker)) });

        new Setting(this.containerEl).setClass('ai-organiser-button-row')
            .addButton((b) => b.setButtonText(c.setupButton).setCta().onClick(() => openInboxSweepSetup(this.plugin, () => this.settingTab.display())))
            .addButton((b) => b.setButtonText(c.runNow).onClick(() => { void runInboxSweep(this.plugin); }));

        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-advanced-group' });
        details.createEl('summary', { text: c.advancedTitle });
        const num = (name: string, get: () => number, set: (n: number) => void): void => {
            new Setting(details).setName(name).addText((tx) => tx.setValue(String(get())).onChange((v) => {
                const n = Math.floor(Number(v));
                if (Number.isFinite(n) && n > 0) { set(n); void this.plugin.saveSettings(); }
            }));
        };
        this.renderContexts(details);
        num(c.maxNotesName, () => s.sweepMaxNotes, (n) => { s.sweepMaxNotes = Math.min(200, n); });
        num(c.maxCharsName, () => s.sweepMaxChars, (n) => { s.sweepMaxChars = Math.min(100000, Math.max(500, n)); });
    }
}
