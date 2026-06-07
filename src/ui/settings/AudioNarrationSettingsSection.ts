/**
 * Audio narration settings section.
 * Lives under Capture & Input umbrella between Audio & Recording and Smart Digitisation.
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { NARRATION_PROVIDERS } from '../../services/tts/ttsProviderRegistry';
import { LLM_ENHANCEMENT_PROVIDERS } from '../../services/audioNarration/llmEnhancerProvider';
import { estimateLlmEnhancementCostUsd } from '../../services/audioNarration/narrationCostEstimator';

export class AudioNarrationSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.audioNarration;
        const newsletterT = this.plugin.t.settings.newsletter;
        this.createSectionHeader(t.title, 'audio-lines', 2);

        // Azure-only honesty: narration is Gemini-TTS-only with no Azure path yet.
        // Surface a clear "coming soon" notice so the feature never appears to
        // silently fail for Azure users.
        if (isAzureMode(this.plugin.settings)) {
            const note = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
            note.createEl('p', { text: t.azureNote });
        }

        // Voice
        new Setting(this.containerEl)
            .setName(t.voice)
            .setDesc(t.voiceDesc)
            .addDropdown(dropdown => {
                const provider = NARRATION_PROVIDERS.gemini;
                for (const v of provider.voices) {
                    // Voice labels live under settings.newsletter.podcastVoice* — shared with newsletter audio.
                    const label = (newsletterT as unknown as Record<string, string>)[v.labelKey.split('.').pop() || ''] || v.id;
                    dropdown.addOption(v.id, label);
                }
                dropdown
                    .setValue(this.plugin.settings.audioNarrationVoice || provider.defaultVoice)
                    .onChange(value => {
                        this.plugin.settings.audioNarrationVoice = value;
                        void this.plugin.saveSettings();
                    });
            });

        // Output folder
        new Setting(this.containerEl)
            .setName(t.outputFolder)
            .setDesc(t.outputFolderDesc)
            .addText(text => text
                .setPlaceholder('Narrations')
                .setValue(this.plugin.settings.audioNarrationOutputFolder)
                .onChange(value => {
                    this.plugin.settings.audioNarrationOutputFolder = value.trim() || 'Narrations';
                    void this.plugin.saveSettings();
                }));

        // Embed in note
        new Setting(this.containerEl)
            .setName(t.embedInNote)
            .setDesc(t.embedInNoteDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.audioNarrationEmbedInNote)
                .onChange(value => {
                    this.plugin.settings.audioNarrationEmbedInNote = value;
                    void this.plugin.saveSettings();
                }));

        // Spoken-content modes — how non-vocal constructs are rendered into prose.
        const m = t.modes;
        new Setting(this.containerEl)
            .setName(m.codeBlockLabel)
            .setDesc(m.codeBlockDesc)
            .addDropdown(dropdown => dropdown
                .addOption('placeholder', m.codeBlockPlaceholder)
                .addOption('omit', m.codeBlockOmit)
                .addOption('read-inline', m.codeBlockReadInline)
                .setValue(this.plugin.settings.audioNarrationCodeBlockMode)
                .onChange(value => {
                    this.plugin.settings.audioNarrationCodeBlockMode = value as 'placeholder' | 'omit' | 'read-inline';
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(m.tableLabel)
            .setDesc(m.tableDesc)
            .addDropdown(dropdown => dropdown
                .addOption('row-prose', m.tableRowProse)
                .addOption('header-summary', m.tableHeaderSummary)
                .addOption('omit', m.tableOmit)
                .setValue(this.plugin.settings.audioNarrationTableMode)
                .onChange(value => {
                    this.plugin.settings.audioNarrationTableMode = value as 'row-prose' | 'header-summary' | 'omit';
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(m.imageLabel)
            .setDesc(m.imageDesc)
            .addDropdown(dropdown => dropdown
                .addOption('alt-text', m.imageAltText)
                .addOption('omit', m.imageOmit)
                .setValue(this.plugin.settings.audioNarrationImageMode)
                .onChange(value => {
                    this.plugin.settings.audioNarrationImageMode = value as 'alt-text' | 'omit';
                    void this.plugin.saveSettings();
                }));

        // Info box
        const info = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        info.createEl('p', { text: t.infoBox });

        // ── AI enhancement (opt-in) ────────────────────────────────────────
        const enhancementContainer = this.containerEl.createDiv();
        this.renderEnhancementSection(enhancementContainer);
    }

    private renderEnhancementSection(container: HTMLElement): void {
        container.empty();
        const tEnh = this.plugin.t.settings.audioNarration.enhancement;

        new Setting(container)
            .setName(tEnh.label)
            .setDesc(tEnh.description)
            .addDropdown(dropdown => dropdown
                .addOption('off', tEnh.off)
                .addOption('on', tEnh.on)
                .setValue(this.plugin.settings.audioNarrationLlmEnhancement)
                .onChange(async (value) => {
                    this.plugin.settings.audioNarrationLlmEnhancement = value as 'off' | 'on';
                    await this.plugin.saveSettings();
                    this.renderEnhancementSection(container);
                }));

        if (this.plugin.settings.audioNarrationLlmEnhancement !== 'on') return;

        // Provider picker (only when toggle is on)
        new Setting(container)
            .setName(tEnh.providerLabel)
            .addDropdown(dropdown => dropdown
                .addOption('gemini', tEnh.providerGemini)
                .addOption('haiku', tEnh.providerHaiku)
                .setValue(this.plugin.settings.audioNarrationLlmProvider)
                .onChange(async (value) => {
                    this.plugin.settings.audioNarrationLlmProvider = value as 'gemini' | 'haiku';
                    await this.plugin.saveSettings();
                    this.renderEnhancementSection(container);
                }));

        // Provider-specific key inputs
        const selected = this.plugin.settings.audioNarrationLlmProvider;
        if (selected === 'gemini') {
            new Setting(container)
                .setName(tEnh.geminiKeyLabel)
                .addText(text => {
                    text.inputEl.type = 'password';
                    text.setPlaceholder(tEnh.geminiKeyPlaceholder);
                    text.setValue(this.plugin.settings.llmEnhancerGeminiApiKey ?? '');
                    text.onChange(async (value) => {
                        this.plugin.settings.llmEnhancerGeminiApiKey = value;
                        await this.plugin.saveSettings();
                    });
                });
            new Setting(container)
                .setName(tEnh.reuseYoutubeKeyLabel)
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.llmEnhancerReuseYoutubeKey)
                    .onChange(async (value) => {
                        this.plugin.settings.llmEnhancerReuseYoutubeKey = value;
                        await this.plugin.saveSettings();
                    }));
        } else {
            new Setting(container)
                .setName(tEnh.anthropicKeyLabel)
                .setDesc(tEnh.anthropicKeyReuseHint)
                .addText(text => {
                    text.inputEl.type = 'password';
                    text.setPlaceholder(tEnh.anthropicKeyPlaceholder);
                    text.setValue(this.plugin.settings.llmEnhancerAnthropicApiKey ?? '');
                    text.onChange(async (value) => {
                        this.plugin.settings.llmEnhancerAnthropicApiKey = value;
                        await this.plugin.saveSettings();
                    });
                });
        }

        // Cost example — runtime-computed for a representative 20-page note
        // (~40,000 chars). Uses the current registry rates so the displayed
        // value tracks any pricing change in one place.
        const providerConfig = LLM_ENHANCEMENT_PROVIDERS[selected];
        const exampleCost = estimateLlmEnhancementCostUsd(40_000, providerConfig);
        const costInfo = container.createDiv({ cls: 'ai-organiser-settings-info' });
        costInfo.createEl('p', {
            text: tEnh.costExampleHint.replace('{cost}', `$${exampleCost.toFixed(2)}`),
        });
    }
}
