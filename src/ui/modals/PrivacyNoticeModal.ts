/**
 * Privacy Notice Modal
 * Shows a one-time privacy warning for cloud LLM usage
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';

export class PrivacyNoticeModal extends Modal {
    private provider: string;
    private onChoice: (proceed: boolean) => void;
    private t: Translations;

    constructor(
        app: App,
        translations: Translations,
        provider: string,
        onChoice: (proceed: boolean) => void
    ) {
        super(app);
        this.t = translations;
        this.provider = provider;
        this.onChoice = onChoice;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-privacy-notice-modal');

        contentEl.createEl('h2', { text: this.t.modals.privacy.title });

        const providerName = this.getProviderDisplayName(this.provider);

        const description = this.t.modals.privacy.description
            .replace('{provider}', providerName);
        contentEl.createEl('p', { text: description });

        // Warning bullets
        const bulletList = contentEl.createEl('ul', { cls: 'ai-organiser-privacy-bullets' });

        const bullet1 = this.t.modals.privacy.bullet1.replace('{provider}', providerName);
        bulletList.createEl('li', { text: bullet1 });

        const bullet2 = this.t.modals.privacy.bullet2.replace('{provider}', providerName);
        bulletList.createEl('li', { text: bullet2 });

        bulletList.createEl('li', { text: this.t.modals.privacy.bullet3 });

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'ai-organiser-modal-buttons' });

        const cancelBtn = buttonContainer.createEl('button', {
            text: this.t.modals.privacy.cancelButton
        });
        cancelBtn.onclick = () => {
            this.close();
            this.onChoice(false);
        };

        const proceedBtn = buttonContainer.createEl('button', {
            text: this.t.modals.privacy.proceedButton,
            cls: 'mod-cta'
        });
        proceedBtn.onclick = () => {
            this.close();
            this.onChoice(true);
        };
    }

    private getProviderDisplayName(provider: string): string {
        const providerNames: Record<string, string> = {
            'openai': 'OpenAI',
            'claude': 'Anthropic Claude',
            'gemini': 'Google Gemini',
            'groq': 'Groq',
            'deepseek': 'DeepSeek',
            'openrouter': 'OpenRouter',
            'aliyun': 'Aliyun',
            'cloud': 'Cloud Provider',
        };
        return providerNames[provider.toLowerCase()] || provider;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
