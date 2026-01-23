import { setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';

export abstract class BaseSettingSection {
    protected plugin: AIOrganiserPlugin;
    protected containerEl: HTMLElement;
    protected settingTab: AIOrganiserSettingTab;

    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        this.plugin = plugin;
        this.containerEl = containerEl;
        this.settingTab = settingTab;
    }

    /**
     * Creates a section header with an icon
     * @param title - The header text
     * @param icon - Lucide icon name (e.g., 'bot', 'tag', 'search')
     * @param level - Header level (1 or 2), defaults to 1
     * @param container - Optional container element, defaults to this.containerEl
     */
    protected createSectionHeader(title: string, icon: string, level: 1 | 2 = 1, container?: HTMLElement): HTMLElement {
        const targetEl = container || this.containerEl;
        const headerEl = targetEl.createEl(level === 1 ? 'h1' : 'h2', { cls: 'ai-organiser-settings-header' });

        const iconEl = headerEl.createSpan({ cls: 'ai-organiser-settings-header-icon' });
        setIcon(iconEl, icon);

        headerEl.createSpan({ text: title });

        return headerEl;
    }

    abstract display(): void | Promise<void>;
}
