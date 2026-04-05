import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';

export class SketchSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.sketch;
        this.createSectionHeader(t?.title || 'Sketch Pad', 'pencil', 2);

        new Setting(this.containerEl)
            .setName(t?.outputFolder || 'Sketch Output Folder')
            .setDesc(t?.outputFolderDesc || 'Where sketch PNG files are saved')
            .addText((text) =>
                text
                    .setPlaceholder('Sketches')
                    .setValue(this.plugin.settings.sketchOutputFolder)
                    .onChange((value) => {
                        this.plugin.settings.sketchOutputFolder = value.trim() || 'Sketches';
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(this.containerEl)
            .setName(t?.autoDigitise || 'Auto Digitise')
            .setDesc(t?.autoDigitiseDesc || 'Automatically run Digitise after saving a sketch')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sketchAutoDigitise)
                    .onChange((value) => {
                        this.plugin.settings.sketchAutoDigitise = value;
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(this.containerEl)
            .setName(t?.defaultPenColour || 'Default Pen Colour')
            .setDesc(t?.defaultPenColourDesc || 'Pen color when opening the sketch pad')
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('#000000', t?.colours?.black || 'Black')
                    .addOption('#2563eb', t?.colours?.blue || 'Blue')
                    .addOption('#dc2626', t?.colours?.red || 'Red')
                    .setValue(this.plugin.settings.sketchDefaultPenColour)
                    .onChange((value) => {
                        this.plugin.settings.sketchDefaultPenColour = value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName(t?.defaultPenWidth || 'Default Pen Width')
            .setDesc(t?.defaultPenWidthDesc || 'Pen thickness from 1 to 8')
            .addSlider((slider) =>
                slider
                    .setLimits(1, 8, 1)
                    .setValue(this.plugin.settings.sketchDefaultPenWidth)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.sketchDefaultPenWidth = value;
                        void this.plugin.saveSettings();
                    })
            );
    }
}

