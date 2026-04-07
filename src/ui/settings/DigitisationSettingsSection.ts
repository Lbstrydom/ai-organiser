/**
 * Digitisation Settings Section — Smart Digitisation configuration (Phase 3)
 */
import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import type { DigitiseMode } from '../../services/visionService';

export class DigitisationSettingsSection extends BaseSettingSection {
    display(): void {
        const { containerEl } = this;
        const t = this.plugin.t.settings.digitisation;

        // Section header
        this.createSectionHeader(
            t?.title || 'Smart digitisation',
            'sparkles',
            2
        );

        // Info box
        const info = containerEl.createEl('div', { cls: 'setting-item-description' });
        info.createEl('p', { text: t?.description || 'Convert images of handwritten notes, whiteboards, and diagrams into structured Markdown and Mermaid diagrams.' });

        // Default mode setting
        new Setting(containerEl)
            .setName(t?.defaultMode || 'Default digitisation mode')
            .setDesc(t?.defaultModeDesc || 'Choose how images are analyzed by default. "Auto" lets the AI determine the content type.')
            .addDropdown(dropdown => {
                const modes: Record<DigitiseMode, string> = {
                    'auto': t?.modes?.auto || 'Auto (detect content type)',
                    'handwriting': t?.modes?.handwriting || 'Handwriting',
                    'diagram': t?.modes?.diagram || 'Diagram',
                    'whiteboard': t?.modes?.whiteboard || 'Whiteboard',
                    'mixed': t?.modes?.mixed || 'Mixed (text + diagrams)'
                };

                for (const [value, label] of Object.entries(modes)) {
                    dropdown.addOption(value, label);
                }

                dropdown
                    .setValue(this.plugin.settings.digitiseDefaultMode)
                    .onChange((value) => {
                        this.plugin.settings.digitiseDefaultMode = value as DigitiseMode;
                        void this.plugin.saveSettings();
                    });
            });

        // Max dimension setting
        new Setting(containerEl)
            .setName(t?.maxDimension || 'Maximum image dimension')
            .setDesc(t?.maxDimensionDesc || 'Resize images to this maximum width/height before sending to AI. Lower values use fewer tokens but may reduce OCR accuracy.')
            .addSlider(slider => {
                slider
                    .setLimits(512, 2048, 256)
                    .setValue(this.plugin.settings.digitiseMaxDimension)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.digitiseMaxDimension = value;
                        void this.plugin.saveSettings();
                    });
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip(t?.resetToDefault || 'Reset to default (1536px)')
                    .onClick(async () => {
                        this.plugin.settings.digitiseMaxDimension = 1536;
                        await this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        // Image quality setting
        new Setting(containerEl)
            .setName(t?.imageQuality || 'Image quality')
            .setDesc(t?.imageQualityDesc || 'JPEG compression quality (0.1-1.0). Higher quality preserves detail but increases file size and token usage.')
            .addSlider(slider => {
                slider
                    .setLimits(0.1, 1.0, 0.05)
                    .setValue(this.plugin.settings.digitiseImageQuality)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.digitiseImageQuality = value;
                        void this.plugin.saveSettings();
                    });
            })
            .addExtraButton(button => {
                button
                    .setIcon('reset')
                    .setTooltip(t?.resetToDefault || 'Reset to default (0.85)')
                    .onClick(async () => {
                        this.plugin.settings.digitiseImageQuality = 0.85;
                        await this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        // --- Image Compression (Phase 5) ---
        containerEl.createEl('h4', { text: t?.offerCompression || 'Image compression' });

        // Offer vault replacement dropdown (image-scoped; audio uses postRecordingStorage)
        new Setting(containerEl)
            .setName(t?.offerCompression || 'Offer image replacement')
            .setDesc(t?.offerCompressionDesc || 'After digitising an image, offer to replace the original with the processed version.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('always', t?.compressionAlways || 'Always')
                    .addOption('large-files', t?.compressionLargeFiles || 'Large files only')
                    .addOption('never', t?.compressionNever || 'Never')
                    .setValue(this.plugin.settings.offerMediaCompression)
                    .onChange((value) => {
                        this.plugin.settings.offerMediaCompression = value as 'always' | 'large-files' | 'never';
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        // Large file threshold slider (only shown when mode is 'large-files')
        if (this.plugin.settings.offerMediaCompression === 'large-files') {
            new Setting(containerEl)
                .setName(t?.threshold || 'Large file threshold')
                .setDesc(t?.thresholdDesc || 'Only offer compression for files larger than this size (in MB).')
                .addSlider(slider => {
                    const currentMB = Math.round(this.plugin.settings.mediaCompressionThreshold / (1024 * 1024));
                    slider
                        .setLimits(1, 20, 1)
                        .setValue(currentMB)
                        .setDynamicTooltip()
                        .onChange((value) => {
                            this.plugin.settings.mediaCompressionThreshold = value * 1024 * 1024;
                            void this.plugin.saveSettings();
                        });
                });
        }
    }
}
