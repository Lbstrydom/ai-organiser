import { Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { getExportOutputFullPath, getEffectiveOutputRoot } from '../../core/settings';
import { resolveTheme } from '../../services/export/markdownPptxGenerator';

export class ExportSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.settings.export?.title || 'Document export', 'file-output', 2);

        if (t.settings.export?.description) {
            this.containerEl.createEl('p', {
                text: t.settings.export.description,
                cls: 'setting-item-description'
            });
        }

        // Output folder — dropdown with existing vault folders + custom path
        const folderSetting = new Setting(this.containerEl)
            .setName(t.settings.export?.outputFolder || 'Output folder')
            .setDesc(t.settings.export?.outputFolderDesc || 'Where to save exported documents');

        const pluginPrefix = `${getEffectiveOutputRoot(this.plugin.settings)}/`;
        const resolvedDefault = getExportOutputFullPath(this.plugin.settings);
        const currentResolved = getExportOutputFullPath(this.plugin.settings);
        const folders = this.getVaultFolders();

        folderSetting.addDropdown(dropdown => {
            dropdown.addOption(resolvedDefault, `${resolvedDefault} (default)`);
            for (const folder of folders) {
                if (folder !== resolvedDefault) {
                    dropdown.addOption(folder, folder);
                }
            }
            dropdown.addOption('__custom__', '— custom path —');

            const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
            dropdown.setValue(isCustom ? '__custom__' : currentResolved);

            dropdown.onChange(value => {
                if (value === '__custom__') {
                    this.settingTab.display();
                } else {
                    const normalized = value.startsWith(pluginPrefix) ? value.slice(pluginPrefix.length) : value;
                    this.plugin.settings.exportOutputFolder = normalized || 'Exports';
                    void this.plugin.saveSettings();
                }
            });
        });

        const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
        if (isCustom) {
            folderSetting.addText(text => text
                .setPlaceholder('Exports')
                .setValue(this.plugin.settings.exportOutputFolder)
                .onChange(value => {
                    let sanitized = (value || 'Exports').trim().replaceAll('\\', '/');
                    while (sanitized.startsWith('/')) sanitized = sanitized.slice(1);
                    while (sanitized.endsWith('/')) sanitized = sanitized.slice(0, -1);
                    const normalized = sanitized.startsWith(pluginPrefix) ? sanitized.slice(pluginPrefix.length) : sanitized;
                    this.plugin.settings.exportOutputFolder = normalized || 'Exports';
                    void this.plugin.saveSettings();
                }));
        }

        // ── Export Theme ──────────────────────────────────────────────────────
        this.containerEl.createEl('h4', { text: t.settings.export?.themeHeader || 'Export theme' });

        // Colour scheme dropdown with preview swatch
        const schemeNames: Record<string, string> = {
            'navy-gold':          'Navy & gold',
            'forest-amber':       'Forest & amber',
            'slate-coral':        'Slate & coral',
            'burgundy-champagne': 'Burgundy & champagne',
            'charcoal-sky':       'Charcoal & sky',
            custom:               t.settings.export?.colorSchemeCustom || 'Custom',
        };

        const schemeSetting = new Setting(this.containerEl)
            .setName(t.settings.export?.colorScheme || 'Colour scheme')
            .setDesc(t.settings.export?.colorSchemeDesc || 'Choose a preset palette or set custom colours below.');

        // Add colour preview swatch after description
        const currentScheme = this.plugin.settings.exportColorScheme ?? 'navy-gold';
        const previewTheme = resolveTheme(
            currentScheme,
            this.plugin.settings.exportPrimaryColor,
            this.plugin.settings.exportAccentColor,
            this.plugin.settings.exportFontFace,
            this.plugin.settings.exportFontSize,
        );
        this.renderColorSwatch(schemeSetting.descEl, previewTheme.primaryColor, previewTheme.accentColor);

        schemeSetting.addDropdown(dropdown => {
            for (const [key, label] of Object.entries(schemeNames)) {
                dropdown.addOption(key, label);
            }
            dropdown.setValue(currentScheme);
            dropdown.onChange(value => {
                this.plugin.settings.exportColorScheme = value;
                void this.plugin.saveSettings();
                this.settingTab.display();
            });
        });

        // Custom colour inputs — only shown when 'custom' selected
        if (currentScheme === 'custom') {
            const primaryVal = this.plugin.settings.exportPrimaryColor ?? '1A3A5C';
            const primarySetting = new Setting(this.containerEl)
                .setName(t.settings.export?.primaryColor || 'Primary colour')
                .setDesc(t.settings.export?.primaryColorDesc || 'Hex colour for headings (no #).');
            this.renderColorSwatch(primarySetting.nameEl, primaryVal);
            primarySetting.addColorPicker(picker => picker
                .setValue(`#${primaryVal}`)
                .onChange(value => {
                    this.plugin.settings.exportPrimaryColor = value.replace('#', '').trim() || '1A3A5C';
                    void this.plugin.saveSettings();
                }));

            const accentVal = this.plugin.settings.exportAccentColor ?? 'F5C842';
            const accentSetting = new Setting(this.containerEl)
                .setName(t.settings.export?.accentColor || 'Accent / complementary colour')
                .setDesc(t.settings.export?.accentColorDesc || 'Hex colour for accent bars and table headers (no #).');
            this.renderColorSwatch(accentSetting.nameEl, accentVal);
            accentSetting.addColorPicker(picker => picker
                .setValue(`#${accentVal}`)
                .onChange(value => {
                    this.plugin.settings.exportAccentColor = value.replace('#', '').trim() || 'F5C842';
                    void this.plugin.saveSettings();
                }));
        }

        // Font family
        new Setting(this.containerEl)
            .setName(t.settings.export?.fontFace || 'Font family')
            .setDesc(t.settings.export?.fontFaceDesc || 'Font for exported documents.')
            .addDropdown(dropdown => {
                const fonts = ['Calibri', 'Arial', 'Noto Sans', 'Times New Roman', 'Georgia', 'Helvetica'];
                for (const f of fonts) dropdown.addOption(f, f);
                dropdown.setValue(this.plugin.settings.exportFontFace ?? 'Noto Sans');
                dropdown.onChange(value => {
                    this.plugin.settings.exportFontFace = value;
                    void this.plugin.saveSettings();
                });
            });

        // Body font size — use setDynamicTooltip (consistent with all peer sliders)
        new Setting(this.containerEl)
            .setName(t.settings.export?.fontSize || 'Body font size (pt)')
            .setDesc(t.settings.export?.fontSizeDesc || 'Point size for body text. Headings scale proportionally.')
            .addSlider(slider => slider
                .setLimits(10, 18, 1)
                .setValue(this.plugin.settings.exportFontSize ?? 14)
                .setDynamicTooltip()
                .onChange(value => {
                    this.plugin.settings.exportFontSize = value;
                    void this.plugin.saveSettings();
                }));
    }

    /** Render inline colour swatch dots */
    private renderColorSwatch(container: HTMLElement, primary: string, accent?: string): void {
        const wrapper = container.createSpan({ cls: 'ai-organiser-color-swatch' });
        wrapper.addClass('ai-organiser-ml-8');
        wrapper.addClass('ai-organiser-inline-flex');
        wrapper.addClass('ai-organiser-gap-4');
        /* verticalAlign handled by parent flex */

        const dot = (hex: string) => {
            const el = wrapper.createSpan();
            el.addClass('ai-organiser-inline-block');
            el.setCssProps({ '--w': '14px' }); el.addClass('ai-organiser-w-custom');
            el.setCssProps({ '--h': '14px' }); el.addClass('ai-organiser-h-custom');
            el.addClass('ai-organiser-rounded-full');
            el.setCssProps({ '--bg': `#${hex}` }); el.addClass('ai-organiser-bg-custom');
            el.addClass('ai-organiser-border');
        };

        dot(primary);
        if (accent) dot(accent);
    }

    private getVaultFolders(): string[] {
        const folders: string[] = [];
        for (const file of this.plugin.app.vault.getAllLoadedFiles()) {
            if (file instanceof TFolder && file.path !== '/') {
                folders.push(file.path);
            }
        }
        folders.sort((a, b) => a.localeCompare(b));
        return folders;
    }
}
