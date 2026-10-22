import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { openInboxSweepSetup, runInboxSweep, sweepBlocker } from '../../commands/inboxSweepCommands';
import { describeError, formatGuidance } from '../../core/friendlyErrors';

/**
 * Inbox sweep settings: a status row, a plain summary of what is swept and what is kept out, the
 * two buttons, and one collapsed Advanced group for the limits. Folder and rule editing happens in
 * the guided setup, so a person never edits a list of rules in a settings file.
 */
export class InboxSweepSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
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

        new Setting(this.containerEl)
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
        num(c.maxNotesName, () => s.sweepMaxNotes, (n) => { s.sweepMaxNotes = Math.min(200, n); });
        num(c.maxCharsName, () => s.sweepMaxChars, (n) => { s.sweepMaxChars = Math.min(100000, Math.max(500, n)); });
    }
}
