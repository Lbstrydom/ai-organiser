import { Notice, Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { FolderListEditor } from '../setup/FolderListEditor';
import { openAgentIndexSetup, runBuild, runCheck, runWriteInstructions } from '../../commands/agentIndexCommands';
import { buildAgentInstructions, buildClaudePermissions } from '../../services/agentIndex/agentInstructions';

/**
 * Agent index settings: a status row, the two folder lists, the rebuild choice and one collapsed
 * Advanced group. Four visible controls; everything else is tucked away.
 */
export class AgentIndexSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const a = t.agentIndex;
        const s = this.plugin.settings;
        this.createSectionHeader(a.sectionTitle, 'list-tree', 2);

        const folders = this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path);
        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: a.statusName,
            evaluation: evaluateSetup('agent-index', s, { existingFolders: toFolderSet(folders) }),
            onOpen: () => openAgentIndexSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: a.description, cls: 'setting-item-description' });

        const editor = (heading: string, help: string, get: () => string[], set: (v: string[]) => void): void => {
            this.containerEl.createEl('h4', { text: heading });
            this.containerEl.createEl('p', { text: help, cls: 'setting-item-description' });
            new FolderListEditor({
                app: this.plugin.app,
                container: this.containerEl,
                t,
                getFolders: get,
                onChange: async (next) => { set([...next]); await this.plugin.saveSettings(); this.settingTab.display(); },
            }).render();
        };
        editor(a.includeHeading, a.includeHelp, () => s.agentIndexIncludeFolders, (v) => { s.agentIndexIncludeFolders = v; });
        editor(a.excludeHeading, a.excludeHelp, () => s.agentIndexExcludeFolders, (v) => { s.agentIndexExcludeFolders = v; });

        new Setting(this.containerEl).setName(a.autoRebuildName).addDropdown((d) => d
            .addOption('off', a.autoRebuildOff)
            .addOption('on-change', a.autoRebuildOnChange)
            .setValue(s.agentIndexAutoRebuild)
            .onChange((v) => { s.agentIndexAutoRebuild = v === 'on-change' ? 'on-change' : 'off'; void this.plugin.saveSettings(); }));

        new Setting(this.containerEl)
            .addButton((b) => b.setButtonText(a.buildNow).setCta().onClick(() => { void runBuild(this.plugin); }))
            .addButton((b) => b.setButtonText(a.checkNow).onClick(() => { void runCheck(this.plugin); }));

        new Setting(this.containerEl)
            .addButton((b) => b.setButtonText(t.commands.copyAgentInstructions).onClick(() => {
                void navigator.clipboard.writeText(buildAgentInstructions(s)).then(() => new Notice(a.instructionsCopied, 5000), () => new Notice(a.copyFailed, 8000));
            }))
            .addButton((b) => b.setButtonText(a.copyPermissions).onClick(() => {
                const text = buildClaudePermissions(s);
                if (text === null) { new Notice(a.noPermissions, 6000); return; }
                void navigator.clipboard.writeText(text).then(() => new Notice(a.permissionsCopied, 5000), () => new Notice(a.copyFailed, 8000));
            }));

        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-advanced-group' });
        details.createEl('summary', { text: a.advancedTitle });
        new Setting(details).setName(a.instructionsWriteName).setDesc(a.instructionsWriteDesc).addToggle((tg) => tg
            .setValue(s.agentInstructionsWrite).onChange((v) => { s.agentInstructionsWrite = v; void this.plugin.saveSettings().then(() => this.settingTab.display()); }));
        if (s.agentInstructionsWrite) {
            new Setting(details).setName(a.instructionsPathName).setDesc(a.instructionsPathDesc)
                .addText((tx) => tx.setValue(s.agentInstructionsPath).onChange((v) => { s.agentInstructionsPath = v.trim(); void this.plugin.saveSettings(); }))
                .addButton((b) => b.setButtonText(a.writeButton).onClick(() => { void runWriteInstructions(this.plugin); }));
        }
        new Setting(details).setName(a.outputPathName).setDesc(a.outputPathDesc).addText((tx) => tx
            .setValue(s.agentIndexOutputPath)
            .onChange((v) => { s.agentIndexOutputPath = v.trim(); void this.plugin.saveSettings(); }));
        new Setting(details).setName(a.aliasesName).setDesc(a.aliasesDesc).addToggle((tg) => tg
            .setValue(s.agentIndexIncludeAliases).onChange((v) => { s.agentIndexIncludeAliases = v; void this.plugin.saveSettings(); }));
        new Setting(details).setName(a.headingsName).setDesc(a.headingsDesc).addToggle((tg) => tg
            .setValue(s.agentIndexIncludeHeadings).onChange((v) => { s.agentIndexIncludeHeadings = v; void this.plugin.saveSettings(); }));
        new Setting(details).setName(a.frontmatterKeysName).setDesc(a.frontmatterKeysDesc).addText((tx) => tx
            .setValue(s.agentIndexFrontmatterKeys.join(', '))
            .onChange((v) => {
                s.agentIndexFrontmatterKeys = v.split(',').map((k) => k.trim()).filter(Boolean);
                void this.plugin.saveSettings();
            }));
        new Setting(details).setName(a.unresolvedName).setDesc(a.unresolvedDesc).addToggle((tg) => tg
            .setValue(s.agentIndexExportUnresolvedLinks).onChange((v) => { s.agentIndexExportUnresolvedLinks = v; void this.plugin.saveSettings(); }));
    }
}
