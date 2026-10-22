import { Notice, Setting } from 'obsidian';
import { FolderSuggest } from './components/FolderSuggest';
import { connectorFolderPath } from '../../services/agentConnectors/connectorRuntime';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
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
            .addText((tx) => {
                // A folder the files could not be written to is said so when the field is left.
                const check = (): void => {
                    const checked = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
                    if (s.agentConnectorFolder !== '' && !checked.ok) new Notice(formatGuidance(describeError(this.plugin.t, checked.error)), 8000);
                };
                const apply = (v: string): void => { s.agentConnectorFolder = v.trim(); void this.plugin.saveSettings(); };
                tx.setPlaceholder(c.folderPlaceholder).setValue(s.agentConnectorFolder).onChange(apply);
                new FolderSuggest(this.plugin.app, tx.inputEl, (v) => { apply(v); check(); });
                tx.inputEl.addEventListener('blur', check);
            });

        new Setting(this.containerEl)
            .addButton((b) => b.setButtonText(c.openButton).setCta().onClick(() => openAgentConnectors(this.plugin)))
            .addButton((b) => b.setButtonText(c.exportButton).onClick(() => { void runExportCommand(this.plugin); }));
    }
}
