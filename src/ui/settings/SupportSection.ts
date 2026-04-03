import { ButtonComponent } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';

export class SupportSection extends BaseSettingSection {

    display(): void {
        this.containerEl.createEl('h3', { text: this.plugin.t.settings.support.title });

        const supportEl = this.containerEl.createDiv({ cls: 'ai-organiser-support-container' });
        supportEl.createSpan({text: this.plugin.t.settings.support.description });

        new ButtonComponent(supportEl)
            .setButtonText(this.plugin.t.settings.support.buyCoffee)
            .setClass('ai-organiser-support-button')
            .onClick(() => {
                window.open('https://buymeacoffee.com/lbstrydom', '_blank');
            });
    }
}
