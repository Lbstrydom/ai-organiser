import { App, Modal, Notice, Platform, Setting, setIcon, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { MinutesService } from '../../services/minutesService';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import { MeetingContext, OutputAudience, ConfidentialityLevel } from '../../services/prompts/minutesPrompts';
import { detectEmbeddedAudio, detectEmbeddedDocuments, DetectedContent } from '../../utils/embeddedContentDetector';

interface ContextDocument {
    file: TFile;
    displayName: string;
    extractedText?: string;
    isProcessing: boolean;
    error?: string;
}

interface MinutesModalState {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    meetingContext: MeetingContext;
    outputAudience: OutputAudience;
    confidentialityLevel: ConfidentialityLevel;
    chair: string;
    personaId: string;
    agenda: string;
    participants: string;
    transcript: string;
    dualOutput: boolean;
    obsidianTasks: boolean;
    languageOverride: string;
    customInstructions: string;
    // Audio transcription
    detectedAudioFiles: DetectedContent[];
    isTranscribing: boolean;
    transcriptionProgress: string;
    // Document context
    contextDocuments: ContextDocument[];
}

export class MinutesCreationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private minutesService: MinutesService;
    private state: MinutesModalState;
    private transcriptTextArea: HTMLTextAreaElement | null = null;
    private privacyWarningEl: HTMLElement | null = null;
    private audioSectionEl: HTMLElement | null = null;
    private documentsSectionEl: HTMLElement | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.minutesService = new MinutesService(plugin);

        this.state = {
            title: '',
            date: this.getTodayDate(),
            startTime: '',
            endTime: '',
            location: '',
            meetingContext: 'internal',
            outputAudience: 'internal',
            confidentialityLevel: 'internal',
            chair: '',
            personaId: plugin.settings.minutesDefaultPersona,
            agenda: '',
            participants: '',
            transcript: '',
            dualOutput: false,
            obsidianTasks: plugin.settings.minutesObsidianTasksFormat,
            languageOverride: 'auto',
            customInstructions: '',
            // Audio transcription
            detectedAudioFiles: [],
            isTranscribing: false,
            transcriptionProgress: '',
            // Document context
            contextDocuments: []
        };
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('minutes-modal');

        contentEl.createEl('h2', {
            text: this.plugin.t.minutes?.modalTitle || 'Meeting Minutes'
        });

        await this.ensurePersonasLoaded();
        this.renderTopSection(contentEl);

        // Desktop-only features: Audio transcription and document context
        if (!Platform.isMobile) {
            await this.detectEmbeddedContent();
            this.renderAudioTranscriptionSection(contentEl);
            this.renderContextDocumentsSection(contentEl);
        }

        this.renderParticipantsSection(contentEl);
        this.renderAdvancedSection(contentEl);
        this.renderFooter(contentEl);

        await this.autoFillTranscriptFromActiveFile();
    }

    private renderTopSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const topSection = containerEl.createDiv({ cls: 'minutes-section minutes-section-top' });

        new Setting(topSection)
            .setName(t?.fieldTitle || 'Meeting title')
            .addText(text => text
                .setPlaceholder('Weekly sync')
                .setValue(this.state.title)
                .onChange(value => this.state.title = value.trim()));

        const row = topSection.createDiv({ cls: 'minutes-row' });
        const dateCol = row.createDiv({ cls: 'minutes-col' });
        const startCol = row.createDiv({ cls: 'minutes-col' });
        const endCol = row.createDiv({ cls: 'minutes-col' });

        new Setting(dateCol)
            .setName(t?.fieldDate || 'Date')
            .addText(text => {
                text.inputEl.type = 'date';
                text.setValue(this.state.date).onChange(value => this.state.date = value);
            });

        new Setting(startCol)
            .setName(t?.fieldStartTime || 'Start time')
            .addText(text => {
                text.inputEl.type = 'time';
                text.setValue(this.state.startTime).onChange(value => this.state.startTime = value);
            });

        new Setting(endCol)
            .setName(t?.fieldEndTime || 'End time')
            .addText(text => {
                text.inputEl.type = 'time';
                text.setValue(this.state.endTime).onChange(value => this.state.endTime = value);
            });

        new Setting(topSection)
            .setName(t?.fieldLocation || 'Location')
            .addText(text => text
                .setPlaceholder('Boardroom or Zoom')
                .setValue(this.state.location)
                .onChange(value => this.state.location = value.trim()));

        const contextRow = topSection.createDiv({ cls: 'minutes-row' });
        const contextCol = contextRow.createDiv({ cls: 'minutes-col' });
        const audienceCol = contextRow.createDiv({ cls: 'minutes-col' });
        const confidentialityCol = contextRow.createDiv({ cls: 'minutes-col' });

        new Setting(contextCol)
            .setName(t?.fieldMeetingContext || 'Meeting context')
            .addDropdown(dropdown => {
                dropdown.addOption('internal', t?.fieldMeetingContextInternal || 'Internal');
                dropdown.addOption('external', t?.fieldMeetingContextExternal || 'External (client/partner)');
                dropdown.addOption('board', t?.fieldMeetingContextBoard || 'Board');
                dropdown.setValue(this.state.meetingContext);
                dropdown.onChange(value => this.state.meetingContext = value as MeetingContext);
            });

        new Setting(audienceCol)
            .setName(t?.fieldOutputAudience || 'Output audience')
            .addDropdown(dropdown => {
                dropdown.addOption('internal', t?.fieldOutputAudienceInternal || 'Internal only');
                dropdown.addOption('external', t?.fieldOutputAudienceExternal || 'External (shareable)');
                dropdown.setValue(this.state.outputAudience);
                dropdown.onChange(value => {
                    this.state.outputAudience = value as OutputAudience;
                    this.updatePrivacyWarning();
                });
            });

        new Setting(confidentialityCol)
            .setName(t?.fieldConfidentiality || 'Confidentiality')
            .addDropdown(dropdown => {
                dropdown.addOption('public', t?.confidentialityPublic || 'Public');
                dropdown.addOption('internal', t?.confidentialityInternal || 'Internal');
                dropdown.addOption('confidential', t?.confidentialityConfidential || 'Confidential');
                dropdown.addOption('strictly_confidential', t?.confidentialityStrict || 'Strictly confidential');
                dropdown.setValue(this.state.confidentialityLevel);
                dropdown.onChange(value => this.state.confidentialityLevel = value as ConfidentialityLevel);
            });

        new Setting(topSection)
            .setName(t?.fieldChair || 'Chair')
            .addText(text => text
                .setPlaceholder('Name')
                .setValue(this.state.chair)
                .onChange(value => this.state.chair = value.trim()));

        new Setting(topSection)
            .setName(t?.fieldPersona || 'Minutes style')
            .addDropdown(dropdown => {
                const personas = this.plugin.configService.getMinutesPersonas();
                void personas.then(list => {
                    list.forEach(p => dropdown.addOption(p.id, p.name));
                    dropdown.setValue(this.state.personaId || list[0]?.id || '');
                    dropdown.onChange(value => this.state.personaId = value);
                });
            });

        new Setting(topSection)
            .setName(t?.fieldAgenda || 'Agenda (one item per line)')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.setValue(this.state.agenda);
                text.onChange(value => this.state.agenda = value);
                text.inputEl.addClass('minutes-textarea');
            });

        new Setting(topSection)
            .setName(t?.fieldTranscript || 'Transcript')
            .setDesc(t?.fieldTranscriptDesc || 'Paste or edit the transcript text')
            .addTextArea(text => {
                text.inputEl.rows = 8;
                text.setValue(this.state.transcript);
                text.onChange(value => this.state.transcript = value);
                text.inputEl.addClass('minutes-textarea');
                this.transcriptTextArea = text.inputEl;
            });

        new Setting(topSection)
            .setName(t?.fieldDualOutput || 'Generate external version')
            .setDesc(t?.fieldDualOutputDesc || 'Creates sanitized version for external sharing')
            .addToggle(toggle => {
                toggle.setValue(this.state.dualOutput);
                toggle.onChange(value => {
                    this.state.dualOutput = value;
                    this.updatePrivacyWarning();
                });
            });

        new Setting(topSection)
            .setName(t?.fieldObsidianTasks || 'Obsidian Tasks format')
            .setDesc(t?.fieldObsidianTasksDesc || 'Add actions as - [ ] checkboxes')
            .addToggle(toggle => {
                toggle.setValue(this.state.obsidianTasks);
                toggle.onChange(value => this.state.obsidianTasks = value);
            });

        const warning = this.plugin.t.minutes?.privacyWarning;
        if (warning) {
            this.privacyWarningEl = topSection.createDiv({ cls: 'minutes-warning' });
            this.privacyWarningEl.setText(warning);
            this.updatePrivacyWarning();
        }
    }

    private renderParticipantsSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const section = this.createCollapsible(containerEl, t?.participantsSection || 'Participants');

        new Setting(section)
            .setName(t?.fieldParticipants || 'Participants')
            .setDesc(t?.fieldParticipantsDesc || 'Paste list here. Format: "Name (Role) - Present/Apologies"')
            .addTextArea(text => {
                text.inputEl.rows = 5;
                text.setValue(this.state.participants);
                text.onChange(value => this.state.participants = value);
                text.inputEl.addClass('minutes-textarea');
            });
    }

    private renderAdvancedSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const section = this.createCollapsible(containerEl, t?.advancedSection || 'Advanced');

        const modelName = this.plugin.llmService.getModelName?.() || this.plugin.settings.cloudModel || this.plugin.settings.localModel;
        new Setting(section)
            .setName(t?.fieldModel || 'Model')
            .setDesc((t?.fieldModelDesc || 'Using configured model') + `: ${modelName}`);

        new Setting(section)
            .setName(t?.fieldLanguageOverride || 'Language override')
            .setDesc(t?.fieldLanguageOverrideDesc || 'Override the minutes output language')
            .addDropdown(dropdown => {
                COMMON_LANGUAGES.forEach(lang => {
                    dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                });
                dropdown.setValue(this.state.languageOverride);
                dropdown.onChange(value => this.state.languageOverride = value);
            });

        new Setting(section)
            .setName(t?.fieldCustomInstructions || 'Custom instructions')
            .setDesc(t?.fieldCustomInstructionsDesc || 'Optional instructions appended to persona')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.setValue(this.state.customInstructions);
                text.onChange(value => this.state.customInstructions = value);
                text.inputEl.addClass('minutes-textarea');
            });
    }

    private renderFooter(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const footer = containerEl.createDiv({ cls: 'minutes-footer' });

        const cancelBtn = footer.createEl('button', { text: this.plugin.t.modals.cancelButton || 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const submitBtn = footer.createEl('button', {
            text: t?.submitButton || 'Create Minutes',
            cls: 'mod-cta'
        });
        submitBtn.addEventListener('click', () => void this.handleSubmit());
    }

    private async handleSubmit(): Promise<void> {
        if (!this.validateRequiredFields()) {
            new Notice(this.plugin.t.minutes?.errorMissingFields || 'Please fill in all required fields');
            return;
        }

        const agendaItems = this.state.agenda
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const metadata = {
            title: this.state.title,
            date: this.state.date,
            startTime: this.state.startTime,
            endTime: this.state.endTime,
            timezone: this.plugin.settings.minutesDefaultTimezone,
            meetingContext: this.state.meetingContext,
            outputAudience: this.state.outputAudience,
            confidentialityLevel: this.state.confidentialityLevel,
            chair: this.state.chair,
            location: this.state.location,
            agenda: agendaItems,
            dualOutput: this.state.dualOutput,
            obsidianTasksFormat: this.state.obsidianTasks,
            minuteTaker: 'AI Organiser'
        };

        const notice = new Notice(this.plugin.t.minutes?.generating || 'Generating minutes...', 0);

        try {
            // Get extracted context from documents
            const contextDocuments = this.getExtractedContextText();

            const result = await this.minutesService.generateMinutes({
                metadata,
                participantsRaw: this.state.participants,
                transcript: this.state.transcript,
                personaId: this.state.personaId,
                outputFolder: this.plugin.settings.minutesOutputFolder,
                customInstructions: this.state.customInstructions,
                languageOverride: this.state.languageOverride,
                contextDocuments: contextDocuments || undefined
            });

            notice.hide();
            new Notice(`${this.plugin.t.minutes?.saved || 'Minutes saved'}: ${result.filePath}`, 4000);
            this.close();
        } catch (error) {
            notice.hide();
            const message = error instanceof Error ? error.message : 'Failed to generate minutes';
            new Notice(`${this.plugin.t.minutes?.errorParsing || 'Failed to parse minutes response'}: ${message}`, 5000);
        }
    }

    private validateRequiredFields(): boolean {
        return !!(
            this.state.title &&
            this.state.date &&
            this.state.startTime &&
            this.state.endTime &&
            this.state.location &&
            this.state.chair &&
            this.state.participants &&
            this.state.transcript
        );
    }

    private async ensurePersonasLoaded(): Promise<void> {
        const personas = await this.plugin.configService.getMinutesPersonas();
        if (personas.length === 0) {
            new Notice(this.plugin.t.minutes?.errorNoPersonas || 'No personas found for meeting minutes');
            this.close();
        }
    }

    private updatePrivacyWarning(): void {
        if (!this.privacyWarningEl) return;
        const showWarning = this.state.outputAudience === 'external' || this.state.dualOutput;
        this.privacyWarningEl.toggleClass('is-hidden', !showWarning);
    }

    private createCollapsible(containerEl: HTMLElement, title: string): HTMLElement {
        const details = containerEl.createEl('details', { cls: 'minutes-collapsible' });
        details.open = false;
        const summary = details.createEl('summary', { text: title });
        summary.addClass('minutes-collapsible-summary');
        const inner = details.createDiv({ cls: 'minutes-collapsible-content' });
        return inner;
    }

    private async autoFillTranscriptFromActiveFile(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !(activeFile instanceof TFile)) {
            return;
        }

        const transcriptFolder = `${this.plugin.settings.pluginFolder}/${this.plugin.settings.transcriptFolder}`;
        if (!activeFile.path.startsWith(transcriptFolder)) {
            return;
        }

        try {
            const content = await this.app.vault.read(activeFile);
            this.state.transcript = content;
            if (this.transcriptTextArea) {
                this.transcriptTextArea.value = content;
            }
        } catch {
            // Ignore auto-fill errors
        }
    }

    private getTodayDate(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // ==================== Audio Transcription ====================

    private async detectEmbeddedContent(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            return;
        }

        try {
            const content = await this.app.vault.read(activeFile);

            // Detect audio files
            this.state.detectedAudioFiles = detectEmbeddedAudio(this.app, content, activeFile);

            // Detect documents (PDFs and Office docs)
            const detectedDocs = detectEmbeddedDocuments(this.app, content, activeFile);
            this.state.contextDocuments = detectedDocs
                .filter(doc => doc.resolvedFile)
                .map(doc => ({
                    file: doc.resolvedFile!,
                    displayName: doc.displayName,
                    isProcessing: false
                }));
        } catch {
            // Ignore detection errors
        }
    }

    private renderAudioTranscriptionSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        // Only show if audio files detected and transcript is empty
        if (this.state.detectedAudioFiles.length === 0) {
            return;
        }

        this.audioSectionEl = containerEl.createDiv({ cls: 'minutes-audio-section' });

        const header = this.audioSectionEl.createDiv({ cls: 'minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'minutes-section-icon' });
        setIcon(iconEl, 'mic');
        header.createSpan({ text: t?.audioTranscriptionSection || 'Audio Transcription' });

        const desc = this.audioSectionEl.createDiv({ cls: 'minutes-section-desc' });
        desc.setText(t?.audioDetected || 'Audio files detected in note. Transcribe to populate transcript.');

        const listEl = this.audioSectionEl.createDiv({ cls: 'minutes-audio-list' });

        for (const audioItem of this.state.detectedAudioFiles) {
            const itemEl = listEl.createDiv({ cls: 'minutes-audio-item' });

            const nameEl = itemEl.createDiv({ cls: 'minutes-audio-name' });
            const fileIcon = nameEl.createSpan({ cls: 'minutes-audio-icon' });
            setIcon(fileIcon, 'file-audio');
            nameEl.createSpan({ text: audioItem.displayName });

            const transcribeBtn = itemEl.createEl('button', {
                text: t?.transcribeButton || 'Transcribe',
                cls: 'minutes-transcribe-btn'
            });
            transcribeBtn.addEventListener('click', () => void this.handleTranscribeAudio(audioItem));
        }

        this.updateAudioSectionUI();
    }

    private updateAudioSectionUI(): void {
        if (!this.audioSectionEl) return;

        const buttons = this.audioSectionEl.querySelectorAll('.minutes-transcribe-btn');
        buttons.forEach(btn => {
            (btn as HTMLButtonElement).disabled = this.state.isTranscribing;
            if (this.state.isTranscribing) {
                btn.textContent = this.state.transcriptionProgress ||
                    (this.plugin.t.minutes?.transcribing || 'Transcribing...');
            } else {
                btn.textContent = this.plugin.t.minutes?.transcribeButton || 'Transcribe';
            }
        });
    }

    private async handleTranscribeAudio(audioItem: DetectedContent): Promise<void> {
        if (!audioItem.resolvedFile) {
            new Notice(this.plugin.t.minutes?.errorAudioNotFound || 'Audio file not found');
            return;
        }

        // Check for transcription provider
        const provider = this.getTranscriptionProvider();
        if (!provider) {
            new Notice(this.plugin.t.minutes?.noTranscriptionProvider ||
                'Configure OpenAI or Groq API key for transcription');
            return;
        }

        this.state.isTranscribing = true;
        this.state.transcriptionProgress = this.plugin.t.minutes?.transcribing || 'Transcribing...';
        this.updateAudioSectionUI();

        try {
            // Import transcription service dynamically to avoid circular deps
            const { transcribeAudio, transcribeChunkedAudioWithCleanup } = await import('../../services/audioTranscriptionService');
            const { needsChunking, compressAndChunkAudio } = await import('../../services/audioCompressionService');

            const file = audioItem.resolvedFile;
            const chunkCheck = await needsChunking(this.app, file);

            let transcript: string;

            if (chunkCheck.needsChunking) {
                // Chunked transcription for long audio
                const chunkResult = await compressAndChunkAudio(this.app, file, (progress) => {
                    this.state.transcriptionProgress = `Compressing: ${Math.round(progress.progress)}%`;
                    this.updateAudioSectionUI();
                });

                if (!chunkResult.success || !chunkResult.chunks || !chunkResult.outputDir) {
                    throw new Error(chunkResult.error || 'Failed to prepare audio chunks');
                }

                const transcriptResult = await transcribeChunkedAudioWithCleanup(
                    chunkResult.chunks,
                    chunkResult.outputDir,
                    {
                        provider: provider.provider,
                        apiKey: provider.apiKey
                    },
                    (progress) => {
                        this.state.transcriptionProgress =
                            `Transcribing chunk ${progress.currentChunk + 1}/${progress.totalChunks} (${Math.round(progress.globalPercent)}%)`;
                        this.updateAudioSectionUI();
                    }
                );

                if (!transcriptResult.success || !transcriptResult.transcript) {
                    throw new Error(transcriptResult.error || 'Transcription failed');
                }
                transcript = transcriptResult.transcript;
            } else {
                // Direct transcription
                this.state.transcriptionProgress = this.plugin.t.minutes?.transcribing || 'Transcribing...';
                this.updateAudioSectionUI();

                const result = await transcribeAudio(this.app, file, {
                    provider: provider.provider,
                    apiKey: provider.apiKey
                });

                if (!result.success || !result.transcript) {
                    throw new Error(result.error || 'Transcription failed');
                }
                transcript = result.transcript;
            }

            // Update state and UI
            this.state.transcript = transcript;
            if (this.transcriptTextArea) {
                this.transcriptTextArea.value = transcript;
            }

            new Notice(this.plugin.t.minutes?.transcriptionComplete || 'Transcription complete');

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`${this.plugin.t.minutes?.transcriptionFailed || 'Transcription failed'}: ${message}`);
        } finally {
            this.state.isTranscribing = false;
            this.state.transcriptionProgress = '';
            this.updateAudioSectionUI();
        }
    }

    private getTranscriptionProvider(): { provider: 'openai' | 'groq'; apiKey: string } | null {
        const settings = this.plugin.settings;

        // Check dedicated transcription settings first
        if (settings.audioTranscriptionProvider && settings.audioTranscriptionApiKey) {
            return {
                provider: settings.audioTranscriptionProvider as 'openai' | 'groq',
                apiKey: settings.audioTranscriptionApiKey
            };
        }

        // Fall back to main provider settings
        if (settings.cloudServiceType === 'openai' && settings.cloudApiKey) {
            return { provider: 'openai', apiKey: settings.cloudApiKey };
        }

        if (settings.cloudServiceType === 'groq' && settings.cloudApiKey) {
            return { provider: 'groq', apiKey: settings.cloudApiKey };
        }

        // Check provider-specific settings
        const openaiKey = settings.providerSettings?.openai?.apiKey;
        if (openaiKey) {
            return { provider: 'openai', apiKey: openaiKey };
        }

        const groqKey = settings.providerSettings?.groq?.apiKey;
        if (groqKey) {
            return { provider: 'groq', apiKey: groqKey };
        }

        return null;
    }

    // ==================== Context Documents ====================

    private renderContextDocumentsSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        this.documentsSectionEl = containerEl.createDiv({ cls: 'minutes-documents-section' });

        const header = this.documentsSectionEl.createDiv({ cls: 'minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'minutes-section-icon' });
        setIcon(iconEl, 'file-text');
        header.createSpan({ text: t?.contextDocumentsSection || 'Context Documents' });

        const desc = this.documentsSectionEl.createDiv({ cls: 'minutes-section-desc' });
        desc.setText(t?.contextDocumentsDesc || 'Attach agendas, presentations, or spreadsheets to improve accuracy');

        // Document list
        const listEl = this.documentsSectionEl.createDiv({ cls: 'minutes-document-list' });
        this.renderDocumentList(listEl);

        // Add document button
        const addRow = this.documentsSectionEl.createDiv({ cls: 'minutes-add-document-row' });
        const addBtn = addRow.createEl('button', {
            text: t?.addDocument || 'Add Document'
        });
        const addIcon = addBtn.createSpan({ cls: 'minutes-btn-icon' });
        setIcon(addIcon, 'plus');
        addBtn.prepend(addIcon);
        addBtn.addEventListener('click', () => void this.openDocumentPicker());

        // Extract all button (if documents exist)
        if (this.state.contextDocuments.length > 0) {
            const extractBtn = addRow.createEl('button', {
                text: t?.extractAll || 'Extract All',
                cls: 'mod-cta'
            });
            extractBtn.addEventListener('click', () => void this.extractAllDocuments());
        }
    }

    private renderDocumentList(listEl: HTMLElement): void {
        listEl.empty();
        const t = this.plugin.t.minutes;

        if (this.state.contextDocuments.length === 0) {
            listEl.createDiv({
                text: t?.noDocumentsAttached || 'No documents attached',
                cls: 'minutes-document-empty'
            });
            return;
        }

        for (let i = 0; i < this.state.contextDocuments.length; i++) {
            const doc = this.state.contextDocuments[i];
            const itemEl = listEl.createDiv({ cls: 'minutes-document-item' });

            const infoEl = itemEl.createDiv({ cls: 'minutes-document-info' });

            const nameRow = infoEl.createDiv({ cls: 'minutes-document-name' });
            const fileIcon = nameRow.createSpan({ cls: 'minutes-document-icon' });
            setIcon(fileIcon, this.getDocumentIcon(doc.file.extension));
            nameRow.createSpan({ text: doc.displayName });

            // Status
            const statusEl = infoEl.createDiv({ cls: 'minutes-document-status' });
            if (doc.isProcessing) {
                statusEl.setText(t?.extracting || 'Extracting...');
            } else if (doc.error) {
                statusEl.addClass('error');
                statusEl.setText(doc.error);
            } else if (doc.extractedText) {
                statusEl.addClass('success');
                const chars = doc.extractedText.length;
                statusEl.setText((t?.documentExtracted || 'Extracted ({chars} chars)').replace('{chars}', String(chars)));
            }

            // Actions
            const actionsEl = itemEl.createDiv({ cls: 'minutes-document-actions' });

            if (!doc.extractedText && !doc.isProcessing) {
                const extractBtn = actionsEl.createEl('button', { text: 'Extract' });
                extractBtn.addEventListener('click', () => void this.extractDocument(i));
            }

            const removeBtn = actionsEl.createEl('button', { cls: 'minutes-document-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.setAttribute('aria-label', t?.removeDocument || 'Remove');
            removeBtn.addEventListener('click', () => this.removeDocument(i));
        }
    }

    private getDocumentIcon(extension: string): string {
        switch (extension.toLowerCase()) {
            case 'pdf': return 'file-text';
            case 'docx':
            case 'doc': return 'file-type';
            case 'xlsx':
            case 'xls': return 'table';
            case 'pptx':
            case 'ppt': return 'presentation';
            default: return 'file';
        }
    }

    private async openDocumentPicker(): Promise<void> {
        // Get all documents in vault
        const files = this.app.vault.getFiles()
            .filter(f => {
                const ext = f.extension.toLowerCase();
                return ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext);
            })
            .sort((a, b) => b.stat.mtime - a.stat.mtime);

        if (files.length === 0) {
            new Notice(this.plugin.t.minutes?.noDocumentsFound || 'No documents found in vault');
            return;
        }

        // Use a simple selection modal
        const { FuzzySuggestModal } = await import('obsidian');

        class DocumentPickerModal extends FuzzySuggestModal<TFile> {
            private onSelect: (file: TFile) => void;

            constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
                super(app);
                this.onSelect = onSelect;
            }

            getItems(): TFile[] {
                return files;
            }

            getItemText(file: TFile): string {
                return file.path;
            }

            onChooseItem(file: TFile): void {
                this.onSelect(file);
            }
        }

        new DocumentPickerModal(this.app, files, (file) => {
            // Check if already added
            if (this.state.contextDocuments.some(d => d.file.path === file.path)) {
                new Notice('Document already added');
                return;
            }

            this.state.contextDocuments.push({
                file,
                displayName: file.name,
                isProcessing: false
            });

            this.refreshDocumentsSection();
        }).open();
    }

    private async extractDocument(index: number): Promise<void> {
        const doc = this.state.contextDocuments[index];
        if (!doc || doc.isProcessing) return;

        doc.isProcessing = true;
        this.refreshDocumentsSection();

        try {
            const { DocumentExtractionService } = await import('../../services/documentExtractionService');
            const extractionService = new DocumentExtractionService(this.app);

            const result = await extractionService.extractText(doc.file);

            if (result.success && result.text) {
                // Truncate very large documents
                const maxChars = 50000;
                doc.extractedText = result.text.length > maxChars
                    ? result.text.substring(0, maxChars) + '\n\n[Truncated...]'
                    : result.text;
            } else {
                doc.error = result.error || 'Extraction failed';
            }
        } catch (error) {
            doc.error = error instanceof Error ? error.message : 'Extraction failed';
        } finally {
            doc.isProcessing = false;
            this.refreshDocumentsSection();
        }
    }

    private async extractAllDocuments(): Promise<void> {
        for (let i = 0; i < this.state.contextDocuments.length; i++) {
            const doc = this.state.contextDocuments[i];
            if (!doc.extractedText && !doc.error) {
                await this.extractDocument(i);
            }
        }
    }

    private removeDocument(index: number): void {
        this.state.contextDocuments.splice(index, 1);
        this.refreshDocumentsSection();
    }

    private refreshDocumentsSection(): void {
        if (!this.documentsSectionEl) return;

        const listEl = this.documentsSectionEl.querySelector('.minutes-document-list');
        if (listEl) {
            this.renderDocumentList(listEl as HTMLElement);
        }
    }

    private getExtractedContextText(): string {
        return this.state.contextDocuments
            .filter(doc => doc.extractedText)
            .map(doc => `### ${doc.displayName}\n\n${doc.extractedText}`)
            .join('\n\n---\n\n');
    }
}
