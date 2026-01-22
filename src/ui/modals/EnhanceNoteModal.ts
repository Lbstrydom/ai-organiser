import { App, Modal, Setting, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export interface EnhanceAction {
    id: string;
    icon?: string;
    label: string;
    description: string;
    onClick: () => void;
}

export class EnhanceNoteModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private actions: EnhanceAction[];

    constructor(app: App, plugin: AIOrganiserPlugin, actions: EnhanceAction[]) {
        super(app);
        this.plugin = plugin;
        this.actions = actions;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-enhance-modal');

        contentEl.createEl('h2', { text: this.plugin.t.modals.enhance.title });

        const actionsContainer = contentEl.createDiv({ cls: 'ai-organiser-enhance-actions' });

        for (const action of this.actions) {
            const actionEl = actionsContainer.createDiv({ cls: 'ai-organiser-enhance-action' });
            const iconEl = actionEl.createEl('span', { cls: 'ai-organiser-enhance-icon' });
            if (action.icon) {
                setIcon(iconEl, action.icon);
            }

            const textEl = actionEl.createDiv({ cls: 'ai-organiser-enhance-text' });
            textEl.createEl('div', { text: action.label, cls: 'ai-organiser-enhance-label' });
            textEl.createEl('div', { text: action.description, cls: 'ai-organiser-enhance-desc' });

            actionEl.addEventListener('click', () => {
                this.close();
                action.onClick();
            });
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
