import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { logger } from '../../utils/logger';

/** Saves run one at a time, so a failed save can only restore the value that was current when it started. */
let saveQueue: Promise<void> = Promise.resolve();

/**
 * Find embeds settings: one switch. "Allow removing links" lets the results window remove the links to a
 * kept file from the notes that hold them (always previewed, protected folders never edited) so the file can
 * then be deleted. Off by default: it is the one part of Find embeds that edits notes.
 */
export class FindEmbedsSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const es = this.plugin.t.embedScan;
        this.createSectionHeader(es.settingsTitle, 'hard-drive', 2);
        new Setting(this.containerEl)
            .setName(es.allowLinkRemovalName)
            .setDesc(es.allowLinkRemovalDesc)
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.attachmentAllowLinkRemoval === true)
                .onChange((value) => {
                    // The runtime value changes NOW (switching it off must stop removal at once); only the save is queued.
                    const previous = this.plugin.settings.attachmentAllowLinkRemoval === true;
                    this.plugin.settings.attachmentAllowLinkRemoval = value;
                    void this.enqueueSave(value, previous);
                }));
    }

    private enqueueSave(value: boolean, previous: boolean): Promise<void> {
        saveQueue = saveQueue.then(() => this.save(value, previous));
        return saveQueue;
    }

    /** `previous` is the value from before THIS change; it is restored only if nothing newer has been chosen since. */
    private async save(value: boolean, previous: boolean): Promise<void> {
        try {
            await this.plugin.saveSettings();
        } catch (e) {
            if (this.plugin.settings.attachmentAllowLinkRemoval === value) this.plugin.settings.attachmentAllowLinkRemoval = previous;
            logger.error('Core', 'Could not save the link removal setting', e);
            new Notice(formatGuidance(describeError(this.plugin.t, 'write-failed')), 8000);
            this.settingTab.display();
        }
    }
}
