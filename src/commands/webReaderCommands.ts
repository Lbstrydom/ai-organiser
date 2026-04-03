/**
 * Web Reader Commands
 * Registers the web-reader command that extracts URLs from a note and opens the triage modal.
 */

import { ButtonComponent, MarkdownView, Modal, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { detectSourcesFromContent } from '../utils/sourceDetection';
import { ensurePrivacyConsent } from '../services/privacyNotice';
import { WebReaderModal } from '../ui/modals/WebReaderModal';

/** Show URL-count confirmation above this threshold */
const WEB_READER_URL_WARN_THRESHOLD = 20;

export function registerWebReaderCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'web-reader',
        name: t.commands.webReader,
        icon: 'newspaper',
        callback: async () => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) {
                new Notice(t.messages.pleaseOpenNote);
                return;
            }

            const content = view.editor.getValue();
            const sources = detectSourcesFromContent(content, plugin.app);
            const urls = sources.urls.map(s => s.value);

            if (urls.length === 0) {
                new Notice(t.modals.webReader.noUrlsFound);
                return;
            }

            // Privacy consent gate (compute effective provider like summarizeCommands.ts)
            const effectiveProvider = plugin.settings.serviceType === 'cloud'
                ? plugin.settings.cloudServiceType
                : 'local';
            const proceed = await ensurePrivacyConsent(plugin, effectiveProvider);
            if (!proceed) return;

            // Large URL set confirmation
            if (urls.length > WEB_READER_URL_WARN_THRESHOLD) {
                const confirmed = await confirmLargeUrlSet(plugin, urls.length);
                if (!confirmed) return;
            }

            new WebReaderModal(plugin.app, plugin, urls).open();
        }
    });
}

function confirmLargeUrlSet(plugin: AIOrganiserPlugin, count: number): Promise<boolean> {
    const t = plugin.t;
    return new Promise<boolean>(resolve => {
        let resolved = false;
        const modal = new (class ConfirmModal extends Modal {
            onOpen() {
                this.titleEl.setText(t.modals.webReader.title);
                const msg = t.modals.webReader.largeSetConfirm.replaceAll('{count}', String(count));
                this.contentEl.createEl('p', { text: msg });
                const actions = this.contentEl.createDiv({ cls: 'ai-organiser-web-reader-actions' });
                new ButtonComponent(actions)
                    .setButtonText(t.modals.webReader.cancelButton)
                    .onClick(() => { resolved = true; resolve(false); this.close(); });
                new ButtonComponent(actions)
                    .setButtonText(t.common?.confirm || 'Continue')
                    .setCta()
                    .onClick(() => { resolved = true; resolve(true); this.close(); });
            }
            onClose() {
                if (!resolved) resolve(false);
            }
        })(plugin.app);
        modal.open();
    });
}
