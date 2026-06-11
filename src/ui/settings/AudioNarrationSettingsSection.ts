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

        // Azure-mode honesty: narration routes via the tts capability (Azure AI
        // Speech / Azure OpenAI / BYO Gemini) — the provider dropdown below is
        // for PRIVATE mode only (gpt-audio is Global-Standard, refused on Azure).
        if (isAzureMode(this.plugin.settings)) {
            const note = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
            note.createEl('p', { text: t.azureNote });
        } else {
            // Narration provider (azure-audio Phase 5): gemini | openai-gpt-audio.
            new Setting(this.containerEl)
                .setName(t.provider)
                .setDesc(t.providerDesc)
                .addDropdown(dropdown => dropdown
                    .addOption('gemini', t.providerGemini)
                    .addOption('openai-gpt-audio', t.providerGptAudio)
                    .setValue(this.plugin.settings.audioNarrationProvider || 'gemini')
                    .onChange(value => {
                        this.plugin.settings.audioNarrationProvider = value as 'gemini' | 'openai-gpt-audio';
                        void this.plugin.saveSettings();
                        this.settingTab.display();   // re-render the voice list for the provider
                    }));
        }

        // Voice — options come from the SELECTED user-facing provider's registry
        // entry (Azure-internal engines bind their own voice setting).
        new Setting(this.containerEl)
            .setName(t.voice)
            .setDesc(t.voiceDesc)
            .addDropdown(dropdown => {
                const selectedId = !isAzureMode(this.plugin.settings)
                    && this.plugin.settings.audioNarrationProvider === 'openai-gpt-audio'
                    ? 'openai-gpt-audio' : 'gemini';
                const provider = NARRATION_PROVIDERS[selectedId];
                const tAll = this.plugin.t as unknown as Record<string, unknown>;
                for (const v of provider.voices) {
                    // Voice labels resolve from the dotted labelKey; Gemini's live
                    // under settings.newsletter.podcastVoice* (shared with newsletter).
                    const leaf = v.labelKey.split('.').pop() || '';
                    const fromNewsletter = (newsletterT as unknown as Record<string, string>)[leaf];
                    const fromNarration = (tAll.settings as Record<string, Record<string, string>>)?.audioNarration?.[leaf];
                    dropdown.addOption(v.id, fromNewsletter || fromNarration || v.id);
                }
                const current = this.plugin.settings.audioNarrationVoice;
                const valid = provider.voices.some((v) => v.id === current);
                dropdown
                    .setValue(valid ? current : provider.defaultVoice)
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
