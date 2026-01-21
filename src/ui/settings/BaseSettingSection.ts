import type { Plugin } from 'obsidian';
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

    abstract display(): void | Promise<void>;
}
