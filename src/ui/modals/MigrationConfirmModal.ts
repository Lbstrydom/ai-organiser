/**
 * Migration Confirmation Modal
 *
 * Shows user confirmation dialog before migrating API keys to SecretStorage.
 * Explains:
 * - Keys will be stored in OS keychain (more secure)
 * - Keys are device-specific (must re-enter on other devices)
 * - Action clears keys from synced settings file
 */

import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export class MigrationConfirmModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private onConfirm: (confirmed: boolean) => void;

    constructor(app: App, plugin: AIOrganiserPlugin, onConfirm: (confirmed: boolean) => void) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl, plugin } = this;
        const t = plugin.t.settings.secretStorage;

        contentEl.createEl('h2', { text: t.migrationTitle });

        // Explanation
        const descEl = contentEl.createDiv({ cls: 'ai-organiser-migration-desc' });
        descEl.createEl('p', { text: t.migrationDesc });

        // Benefits section
        const benefitsEl = contentEl.createDiv({ cls: 'ai-organiser-migration-benefits' });
        benefitsEl.createEl('h4', { text: t.benefitsTitle });
        const benefitsList = benefitsEl.createEl('ul');
        benefitsList.createEl('li', { text: t.benefit1 });
        benefitsList.createEl('li', { text: t.benefit2 });
        benefitsList.createEl('li', { text: t.benefit3 });

        // Important warnings
        const warningBox = contentEl.createDiv({ cls: 'ai-organiser-migration-warning' });
        warningBox.createEl('h4', { text: '⚠️ ' + t.importantTitle });
        const warningList = warningBox.createEl('ul');
        warningList.createEl('li', { text: t.warning1 });
        warningList.createEl('li', { text: t.warning2 });
        warningList.createEl('li', { text: t.warning3 });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-migration-buttons' });

        new Setting(buttonContainer)
            .addButton(btn =>
                btn
                    .setButtonText(t.cancel)
                    .onClick(() => {
                        this.onConfirm(false);
                        this.close();
                    })
            )
            .addButton(btn =>
                btn
                    .setButtonText(t.migrateNow)
                    .setCta()
                    .onClick(() => {
                        this.onConfirm(true);
                        this.close();
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
