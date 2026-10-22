import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { openAgentConnectors, runExportCommand } from '../../commands/agentConnectorCommands';

/** Connect an AI app: where the made files go, the guide, and the vault map export. */
export class AgentConnectorsSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const c = this.plugin.t.agentConnectors;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'plug-zap', 2);
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        new Setting(this.containerEl)
            .setName(c.folderName)
            .setDesc(c.folderDesc)
            .addText((tx) => tx
                .setPlaceholder(c.folderPlaceholder)
                .setValue(s.agentConnectorFolder)
                .onChange((v) => { s.agentConnectorFolder = v.trim(); void this.plugin.saveSettings(); }));

        new Setting(this.containerEl)
            .addButton((b) => b.setButtonText(c.openButton).setCta().onClick(() => openAgentConnectors(this.plugin)))
            .addButton((b) => b.setButtonText(c.exportButton).onClick(() => { void runExportCommand(this.plugin); }));
    }
}
