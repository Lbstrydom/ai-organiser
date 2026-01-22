/**
 * NotebookLM Settings Section
 * Settings UI for configuring NotebookLM source pack exports
 */

import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';

export class NotebookLMSettingsSection extends BaseSettingSection {
    constructor(
        plugin: AIOrganiserPlugin,
        containerEl: HTMLElement,
        settingTab: AIOrganiserSettingTab
    ) {
        super(plugin, containerEl, settingTab);
    }

    async display(): Promise<void> {
        const { containerEl, plugin } = this;
        const t = plugin.t.settings.notebookLM;

        // Main section header
        containerEl.createEl('h3', { text: t?.title || 'NotebookLM Integration' });

        // Description
        containerEl.createEl('p', {
            text: t?.description || 'Export Obsidian notes as sanitized source packs for NotebookLM.',
            cls: 'setting-item-description'
        });

        // === Selection Settings ===
        containerEl.createEl('h4', { text: t?.selectionTitle || 'Selection' });

        // Selection tag
        new Setting(containerEl)
            .setName(t?.selectionTag || 'Selection Tag')
            .setDesc(t?.selectionTagDesc || 'Tag to mark notes for NotebookLM export')
            .addText(text =>
                text
                    .setPlaceholder('notebooklm')
                    .setValue(plugin.settings.notebooklmSelectionTag)
                    .onChange(async value => {
                        plugin.settings.notebooklmSelectionTag = value || 'notebooklm';
                        await plugin.saveSettings();
                    })
            );

        // Export folder
        new Setting(containerEl)
            .setName(t?.exportFolder || 'Export Folder')
            .setDesc(t?.exportFolderDesc || 'Subfolder for source pack exports (under AI-Organiser/)')
            .addText(text =>
                text
                    .setPlaceholder('NotebookLM')
                    .setValue(plugin.settings.notebooklmExportFolder)
                    .onChange(async value => {
                        plugin.settings.notebooklmExportFolder = value || 'NotebookLM';
                        await plugin.saveSettings();
                    })
            );

        // === Export Settings ===
        containerEl.createEl('h4', { text: t?.exportTitle || 'Export' });

        // Export mode
        new Setting(containerEl)
            .setName(t?.exportMode || 'Export Mode')
            .setDesc(t?.exportModeDesc || 'How to split notes into module files')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('auto', t?.modeAuto || 'Auto (recommended)')
                    .addOption('modular', t?.modeModular || 'Modular (split by word budget)')
                    .addOption('single', t?.modeSingle || 'Single file')
                    .setValue(plugin.settings.notebooklmExportMode)
                    .onChange(async value => {
                        plugin.settings.notebooklmExportMode = value as 'auto' | 'modular' | 'single';
                        await plugin.saveSettings();
                    })
            );

        // Max words per module
        new Setting(containerEl)
            .setName(t?.maxWords || 'Words per Module')
            .setDesc(t?.maxWordsDesc || 'Target word count per module (max: 500,000)')
            .addText(text => {
                text
                    .setPlaceholder('120000')
                    .setValue(plugin.settings.notebooklmMaxWordsPerModule.toString())
                    .onChange(async value => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 1000 && num <= 500000) {
                            plugin.settings.notebooklmMaxWordsPerModule = num;
                            await plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1000';
                text.inputEl.max = '500000';
            });

        // Post-export action
        new Setting(containerEl)
            .setName(t?.postExport || 'After Export')
            .setDesc(t?.postExportDesc || 'What to do with selection tags after export')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('keep', t?.actionKeep || 'Keep tags')
                    .addOption('clear', t?.actionClear || 'Clear tags')
                    .addOption('archive', t?.actionArchive || 'Archive (rename to notebooklm/exported)')
                    .setValue(plugin.settings.notebooklmPostExportTagAction)
                    .onChange(async value => {
                        plugin.settings.notebooklmPostExportTagAction = value as 'keep' | 'clear' | 'archive';
                        await plugin.saveSettings();
                    })
            );

        // === Sanitisation Settings ===
        containerEl.createEl('h4', { text: t?.sanitisationTitle || 'Sanitisation' });

        // Remove frontmatter
        new Setting(containerEl)
            .setName(t?.removeFrontmatter || 'Remove Frontmatter')
            .setDesc(t?.removeFrontmatterDesc || 'Strip YAML frontmatter from exported notes')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmRemoveFrontmatter)
                    .onChange(async value => {
                        plugin.settings.notebooklmRemoveFrontmatter = value;
                        await plugin.saveSettings();
                    })
            );

        // Flatten callouts
        new Setting(containerEl)
            .setName(t?.flattenCallouts || 'Flatten Callouts')
            .setDesc(t?.flattenCalloutsDesc || 'Convert callout blocks to plain text')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmFlattenCallouts)
                    .onChange(async value => {
                        plugin.settings.notebooklmFlattenCallouts = value;
                        await plugin.saveSettings();
                    })
            );

        // Strip Dataview
        new Setting(containerEl)
            .setName(t?.stripDataview || 'Strip Dataview')
            .setDesc(t?.stripDataviewDesc || 'Remove dataview code blocks')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmStripDataview)
                    .onChange(async value => {
                        plugin.settings.notebooklmStripDataview = value;
                        await plugin.saveSettings();
                    })
            );

        // Strip DataviewJS
        new Setting(containerEl)
            .setName(t?.stripDataviewJs || 'Strip DataviewJS')
            .setDesc(t?.stripDataviewJsDesc || 'Remove dataviewjs code blocks')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmStripDataviewJs)
                    .onChange(async value => {
                        plugin.settings.notebooklmStripDataviewJs = value;
                        await plugin.saveSettings();
                    })
            );

        // Image handling
        new Setting(containerEl)
            .setName(t?.imageHandling || 'Image Handling')
            .setDesc(t?.imageHandlingDesc || 'How to handle image references')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('strip', t?.imageStrip || 'Remove images')
                    .addOption('placeholder', t?.imagePlaceholder || 'Replace with placeholder')
                    .addOption('exportAssets', t?.imageExport || 'Export to assets folder')
                    .setValue(plugin.settings.notebooklmImageHandling)
                    .onChange(async value => {
                        plugin.settings.notebooklmImageHandling = value as 'strip' | 'placeholder' | 'exportAssets';
                        await plugin.saveSettings();
                    })
            );

        // === Embed Settings ===
        containerEl.createEl('h4', { text: t?.embedTitle || 'Embed Handling' });

        // Resolve embeds
        new Setting(containerEl)
            .setName(t?.resolveEmbeds || 'Resolve Embeds')
            .setDesc(t?.resolveEmbedsDesc || 'How to handle note transclusions (![[Note]])')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('none', t?.embedNone || 'Omit embed content')
                    .addOption('titleOnly', t?.embedTitle || 'Include title only')
                    .addOption('excerpt', t?.embedExcerpt || 'Include excerpt')
                    .setValue(plugin.settings.notebooklmResolveEmbeds)
                    .onChange(async value => {
                        plugin.settings.notebooklmResolveEmbeds = value as 'none' | 'titleOnly' | 'excerpt';
                        await plugin.saveSettings();
                    })
            );

        // Embed max depth
        new Setting(containerEl)
            .setName(t?.embedMaxDepth || 'Embed Max Depth')
            .setDesc(t?.embedMaxDepthDesc || 'Maximum recursion depth for embedded notes')
            .addText(text => {
                text
                    .setPlaceholder('2')
                    .setValue(plugin.settings.notebooklmEmbedMaxDepth.toString())
                    .onChange(async value => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 1 && num <= 10) {
                            plugin.settings.notebooklmEmbedMaxDepth = num;
                            await plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = '10';
            });

        // Embed max chars
        new Setting(containerEl)
            .setName(t?.embedMaxChars || 'Embed Max Characters')
            .setDesc(t?.embedMaxCharsDesc || 'Maximum characters per resolved embed')
            .addText(text => {
                text
                    .setPlaceholder('2000')
                    .setValue(plugin.settings.notebooklmEmbedMaxChars.toString())
                    .onChange(async value => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 100 && num <= 50000) {
                            plugin.settings.notebooklmEmbedMaxChars = num;
                            await plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '100';
                text.inputEl.max = '50000';
            });

        // === Link Context (Advanced) ===
        containerEl.createEl('h4', { text: t?.linkContextTitle || 'Link Context (Advanced)' });

        // Include link context
        new Setting(containerEl)
            .setName(t?.includeLinkContext || 'Include Link Context')
            .setDesc(t?.includeLinkContextDesc || 'Add context snippets for outgoing links')
            .addToggle(toggle =>
                toggle
                    .setValue(plugin.settings.notebooklmIncludeLinkContext)
                    .onChange(async value => {
                        plugin.settings.notebooklmIncludeLinkContext = value;
                        await plugin.saveSettings();
                    })
            );

        // Link context max chars
        new Setting(containerEl)
            .setName(t?.linkContextMaxChars || 'Link Context Max Characters')
            .setDesc(t?.linkContextMaxCharsDesc || 'Maximum characters of context per link')
            .addText(text => {
                text
                    .setPlaceholder('1000')
                    .setValue(plugin.settings.notebooklmLinkContextMaxChars.toString())
                    .onChange(async value => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 100 && num <= 10000) {
                            plugin.settings.notebooklmLinkContextMaxChars = num;
                            await plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '100';
                text.inputEl.max = '10000';
            });
    }
}
