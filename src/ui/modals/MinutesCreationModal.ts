import { App, FuzzySuggestModal, Modal, Notice, Platform, Setting, setIcon, setTooltip, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { MinutesService } from '../../services/minutesService';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import { MeetingContext, OutputAudience, ConfidentialityLevel } from '../../services/prompts/minutesPrompts';
import { detectEmbeddedAudio, DetectedContent } from '../../utils/embeddedContentDetector';
import { DictionaryService, Dictionary } from '../../services/dictionaryService';
import { DocumentExtractionService } from '../../services/documentExtractionService';
import { getConfigFolderFullPath } from '../../core/settings';
import {
    ALL_DOCUMENT_EXTENSIONS,
    DEFAULT_MAX_DOCUMENT_CHARS,
    TruncationChoice
} from '../../core/constants';
import { DocumentHandlingController, DocumentItem } from '../controllers/DocumentHandlingController';
import { AudioController } from '../controllers/AudioController';
import { DictionaryController } from '../controllers/DictionaryController';
import { getTruncationOptions } from '../utils/truncation';
import {
    createTruncationWarning,
    createBulkTruncationControls
} from '../components/TruncationControls';
import { withBusyIndicator } from '../../utils/busyIndicator';

// ContextDocument interface removed - using DocumentItem from DocumentHandlingController

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
    transcriptionLanguage: string;
    // Document context (managed by controller)
    // contextDocuments removed - access via docController
    // Dictionary
    selectedDictionaryId: string;
    availableDictionaries: Dictionary[];
    isExtractingDictionary: boolean;
    dictionaryExtractionProgress: string;
    dictionaryAutoExtractOffered: boolean;
    // Bulk truncation
    bulkTruncationChoice: TruncationChoice;
}

/**
 * Service dependencies for MinutesCreationModal
 * Supports dependency injection for testing
 */
export interface MinutesModalDependencies {
    minutesService?: MinutesService;
    dictionaryService?: DictionaryService;
    documentService?: DocumentExtractionService;
    docController?: DocumentHandlingController;
    audioController?: AudioController;
    dictController?: DictionaryController;
}

export class MinutesCreationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private minutesService: MinutesService;
    private dictionaryService: DictionaryService;
    private documentService: DocumentExtractionService;
    private docController!: DocumentHandlingController;
    private audioController!: AudioController;
    private dictController!: DictionaryController;
    private state: MinutesModalState;
    private transcriptTextArea: HTMLTextAreaElement | null = null;
    private agendaTextArea: HTMLTextAreaElement | null = null;
    private participantsTextArea: HTMLTextAreaElement | null = null;
    private privacyWarningEl: HTMLElement | null = null;
    private audioSectionEl: HTMLElement | null = null;
    private documentsSectionEl: HTMLElement | null = null;
    private bulkTruncationEl: HTMLElement | null = null;
    private dictionarySectionEl: HTMLElement | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin, deps?: MinutesModalDependencies) {
        super(app);
        this.plugin = plugin;
        // Support dependency injection for testing, with default implementations
        this.minutesService = deps?.minutesService ?? new MinutesService(plugin);
        this.dictionaryService = deps?.dictionaryService ?? new DictionaryService(app, getConfigFolderFullPath(plugin.settings));
        this.documentService = deps?.documentService ?? new DocumentExtractionService(app);

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
            transcriptionLanguage: 'auto',
            // Document context
            // contextDocuments removed - managed by docController
            // Dictionary
            selectedDictionaryId: '',
            availableDictionaries: [],
            isExtractingDictionary: false,
            dictionaryExtractionProgress: '',
            dictionaryAutoExtractOffered: false,
            // Bulk truncation
            bulkTruncationChoice: 'truncate'
        };
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('minutes-modal');

        // Instantiate controllers per modal open to avoid stale state
        this.docController = new DocumentHandlingController(
            this.app,
            this.plugin,
            this.documentService
        );
        this.audioController = new AudioController(this.app);
        this.dictController = new DictionaryController(this.dictionaryService);

        contentEl.createEl('h2', {
            text: this.plugin.t.minutes?.modalTitle || 'Meeting Minutes'
        });

        await this.ensurePersonasLoaded();
        this.renderTopSection(contentEl);

        // Desktop-only features: Document context, dictionary, and audio transcription
        // Order matters for gestalt: extract docs first, then dictionary, then transcribe
        if (!Platform.isMobile) {
            await this.detectEmbeddedContent();
            await this.loadAvailableDictionaries();
            this.renderContextDocumentsSection(contentEl);
            this.renderDictionarySection(contentEl);
            this.renderAudioTranscriptionSection(contentEl);
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
                    if (list.length === 0) {
                        // Fallback if no personas loaded
                        dropdown.addOption('default', 'Default Style');
                        dropdown.setValue('default');
                    } else {
                        list.forEach(p => dropdown.addOption(p.id, p.name));
                        dropdown.setValue(this.state.personaId || list[0]?.id || '');
                    }
                    dropdown.onChange(value => this.state.personaId = value);
                }).catch(() => {
                    dropdown.addOption('default', 'Default Style');
                    dropdown.setValue('default');
                });
            });

        new Setting(topSection)
            .setName(t?.fieldAgenda || 'Agenda (one item per line)')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.setValue(this.state.agenda);
                text.onChange(value => this.state.agenda = value);
                text.inputEl.addClass('minutes-textarea');
                this.agendaTextArea = text.inputEl;
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
                this.participantsTextArea = text.inputEl;
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

            // Get dictionary content if selected
            const dictionaryContent = await this.getDictionaryContent();

            const result = await this.minutesService.generateMinutes({
                metadata,
                participantsRaw: this.state.participants,
                transcript: this.state.transcript,
                personaId: this.state.personaId,
                outputFolder: this.plugin.settings.minutesOutputFolder,
                customInstructions: this.state.customInstructions,
                languageOverride: this.state.languageOverride,
                contextDocuments: contextDocuments || undefined,
                dictionaryContent: dictionaryContent || undefined
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

    private async ensurePersonasLoaded(): Promise<boolean> {
        try {
            const personas = await this.plugin.configService.getMinutesPersonas();
            if (personas.length === 0) {
                console.warn('[AI Organiser] No minutes personas found, using default');
                // Don't close - we'll handle this in the dropdown
                return false;
            }
            return true;
        } catch (error) {
            console.error('[AI Organiser] Failed to load minutes personas:', error);
            new Notice(this.plugin.t.minutes?.errorNoPersonas || 'Failed to load personas - using defaults');
            return false;
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

            // Detect documents (PDFs and Office docs) using controller
            this.docController.addDetectedFromContent(content);
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

        // Language selection for transcription
        const langRow = this.audioSectionEl.createDiv({ cls: 'minutes-audio-language-row' });
        langRow.createSpan({ text: t?.transcriptionLanguage || 'Audio language:', cls: 'minutes-audio-language-label' });
        const langSelect = langRow.createEl('select', { cls: 'minutes-audio-language-select' });

        for (const lang of COMMON_LANGUAGES) {
            const opt = langSelect.createEl('option', { value: lang.code });
            opt.textContent = getLanguageDisplayName(lang);
            if (lang.code === this.state.transcriptionLanguage) {
                opt.selected = true;
            }
        }

        langSelect.addEventListener('change', () => {
            this.state.transcriptionLanguage = langSelect.value;
        });

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
                        apiKey: provider.apiKey,
                        language: this.getTranscriptionLanguageCode()
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
                    apiKey: provider.apiKey,
                    language: this.getTranscriptionLanguageCode()
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

    /** Get transcription language code (undefined for auto-detect) */
    private getTranscriptionLanguageCode(): string | undefined {
        return this.state.transcriptionLanguage === 'auto' ? undefined : this.state.transcriptionLanguage;
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

        // Bulk truncation control (rendered only when applicable)
        this.bulkTruncationEl = this.documentsSectionEl.createDiv({ cls: 'minutes-bulk-truncation' });
        this.renderBulkTruncationControl();

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
        addBtn.addEventListener('click', () => this.openDocumentPicker());

        // Extract all button (if documents exist)
        if (this.docController.getCount() > 0) {
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
        const documents = this.docController.getDocuments();

        if (documents.length === 0) {
            listEl.createDiv({
                text: t?.noDocumentsAttached || 'No documents attached',
                cls: 'minutes-document-empty'
            });
            return;
        }

        for (const doc of documents) {
            const itemEl = listEl.createDiv({ cls: 'minutes-document-item' });

            const infoEl = itemEl.createDiv({ cls: 'minutes-document-info' });

            const nameRow = infoEl.createDiv({ cls: 'minutes-document-name' });
            const fileIcon = nameRow.createSpan({ cls: 'minutes-document-icon' });
            const extension = doc.file?.extension || doc.name.split('.').pop() || '';
            setIcon(fileIcon, this.getDocumentIcon(extension));
            nameRow.createSpan({ text: doc.name });

            // Status
            const statusEl = infoEl.createDiv({ cls: 'minutes-document-status' });
            this.renderDocumentStatus(doc, statusEl);

            // Actions
            const actionsEl = itemEl.createDiv({ cls: 'minutes-document-actions' });

            if (!doc.extractedText && !doc.isProcessing && !doc.error) {
                const extractBtn = actionsEl.createEl('button', { text: 'Extract' });
                extractBtn.addEventListener('click', () => void this.extractDocumentFromUI(doc));
            }

            const removeBtn = actionsEl.createEl('button', { cls: 'minutes-document-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.setAttribute('aria-label', t?.removeDocument || 'Remove');
            removeBtn.addEventListener('click', () => this.removeDocumentFromUI(doc));
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
            case 'txt':
            case 'rtf': return 'file-text';
            default: return 'file';
        }
    }

    private openDocumentPicker(): void {
        try {
            // Get all documents in vault
            const files = this.app.vault.getFiles()
                .filter(f => {
                    const ext = f.extension.toLowerCase();
                    return ALL_DOCUMENT_EXTENSIONS.includes(ext as typeof ALL_DOCUMENT_EXTENSIONS[number]);
                })
                .sort((a, b) => b.stat.mtime - a.stat.mtime);

            if (files.length === 0) {
                new Notice(this.plugin.t.minutes?.noDocumentsFound || 'No documents found in vault');
                return;
            }

            // Create picker modal using static import
            const picker = new DocumentPickerModal(this.app, files, (file) => {
                // Add via controller
                const result = this.docController.addFromVault(file);
                if (!result.added) {
                    new Notice(result.error || 'Failed to add document');
                    return;
                }

                this.refreshDocumentsSection();
            });
            picker.open();
        } catch (error) {
            console.error('[AI Organiser] Failed to open document picker:', error);
            new Notice('Failed to open document picker');
        }
    }

    private async extractDocumentFromUI(doc: DocumentItem): Promise<void> {
        const docId = this.getDocumentId(doc);
        await this.docController.extractDocument(docId);
        this.refreshDocumentsSection();
        this.autoFillFromDocuments();
    }

    private async extractAllDocuments(): Promise<void> {
        const t = this.plugin.t.minutes;
        const documents = this.docController.getDocuments();

        // Check if there's anything to extract
        const unextracted = documents.filter(d => !d.extractedText && !d.error);
        if (unextracted.length === 0) {
            new Notice(t?.allDocumentsExtracted || 'All documents already extracted');
            return;
        }

        // Show extraction in progress
        new Notice(t?.extractingDocuments?.replace('{count}', String(unextracted.length)) ||
            `Extracting ${unextracted.length} document(s)...`);

        const result = await this.docController.extractAll();

        // Show result feedback
        if (result.errors.length > 0) {
            console.warn('[AI Organiser] Extraction errors:', result.errors);
            new Notice(t?.extractionErrors?.replace('{count}', String(result.errors.length)) ||
                `Extraction completed with ${result.errors.length} error(s)`);
        } else {
            new Notice(t?.extractionComplete || 'Document extraction complete');
        }

        this.refreshDocumentsSection();
        this.autoFillFromDocuments();
    }

    private removeDocumentFromUI(doc: DocumentItem): void {
        const docId = this.getDocumentId(doc);
        const removed = this.docController.removeDocument(docId);
        if (removed) {
            this.refreshDocumentsSection();
        }
    }

    private getDocumentId(doc: DocumentItem): string {
        return DocumentHandlingController.getDocumentId(doc);
    }

    private refreshDocumentsSection(): void {
        if (!this.documentsSectionEl) return;

        this.renderBulkTruncationControl();

        const listEl = this.documentsSectionEl.querySelector('.minutes-document-list');
        if (listEl) {
            this.renderDocumentList(listEl as HTMLElement);
        }
    }

    /**
     * Auto-fill form fields from extracted document content
     * - Detects agenda documents and fills Agenda field
     * - Extracts participant names and suggests them
     * - Offers to extract dictionary terms if a dictionary is selected
     */
    private autoFillFromDocuments(): void {
        const documents = this.docController.getDocuments();

        for (const doc of documents) {
            if (!doc.extractedText) continue;

            this.tryAutoFillAgenda(doc);
            this.tryAutoFillParticipants(doc);
        }

        // Offer dictionary extraction if dictionary is selected and we haven't offered yet
        this.tryOfferDictionaryExtraction();
    }

    /**
     * Offer to extract dictionary terms from documents
     * Only offers once per session and only if a dictionary is selected
     */
    private tryOfferDictionaryExtraction(): void {
        // Don't offer if we've already offered or currently extracting
        if (this.state.dictionaryAutoExtractOffered || this.state.isExtractingDictionary) return;

        // Don't offer if no dictionary selected
        if (!this.state.selectedDictionaryId) return;

        // Check if any documents have extracted text
        const documents = this.docController.getDocuments();
        const hasExtractedContent = documents.some(doc => doc.extractedText);
        if (!hasExtractedContent) return;

        // Mark as offered so we don't ask again
        this.state.dictionaryAutoExtractOffered = true;

        // Auto-trigger extraction
        const t = this.plugin.t.minutes;
        new Notice(t?.dictionaryAutoExtracting || 'Extracting terminology from documents...');
        void this.handleExtractDictionaryFromDocs();
    }

    private tryAutoFillAgenda(doc: DocumentItem): void {
        if (this.state.agenda.trim()) return; // Already has content

        const nameLower = doc.name.toLowerCase();
        if (!this.isAgendaDocument(nameLower)) return;

        const agendaContent = this.extractAgendaItems(doc.extractedText || '');
        if (!agendaContent) return;

        this.state.agenda = agendaContent;
        if (this.agendaTextArea) {
            this.agendaTextArea.value = agendaContent;
        }
        const t = this.plugin.t.minutes;
        new Notice(t?.agendaAutoFilled || 'Agenda auto-filled from document');
    }

    private tryAutoFillParticipants(doc: DocumentItem): void {
        if (this.state.participants.trim()) return; // Already has content

        const names = this.extractParticipantNames(doc.extractedText || '');
        if (names.length === 0) return;

        const participantsList = names.join('\n');
        this.state.participants = participantsList;
        if (this.participantsTextArea) {
            this.participantsTextArea.value = participantsList;
        }
        const t = this.plugin.t.minutes;
        new Notice(t?.participantsAutoExtracted || `Found ${names.length} participant names`);
    }

    /**
     * Check if document name indicates it's an agenda
     */
    private isAgendaDocument(nameLower: string): boolean {
        const agendaKeywords = ['agenda', 'programme', 'program'];
        return agendaKeywords.some(kw => nameLower.includes(kw));
    }

    /** Regex for list item prefixes: 1. or 1) followed by space, or * - •
     *  The \s+ after digit+period prevents matching times like "10.00" (no space after .)
     *  But correctly matches "1. 10.00 – 10.05" by stripping "1. " prefix */
    private static readonly LIST_ITEM_PREFIX = /^(\d{1,2}[.)]\s+|[*\-•]\s+)/;
    /** Regex for agenda section headers */
    private static readonly AGENDA_HEADER = /^(agenda|programme|program|items?|topics?)/i;
    /** Regex for end of agenda section */
    private static readonly AGENDA_END = /^(attendees|participants|present|apologies|minutes|notes)/i;

    /**
     * Extract agenda items from document text
     */
    private extractAgendaItems(text: string): string {
        const lines = text.split('\n');
        const agendaItems: string[] = [];
        let inAgendaSection = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (MinutesCreationModal.AGENDA_HEADER.test(trimmed)) {
                inAgendaSection = true;
                continue;
            }

            if (inAgendaSection && MinutesCreationModal.AGENDA_END.test(trimmed)) {
                break;
            }

            const isListItem = MinutesCreationModal.LIST_ITEM_PREFIX.test(trimmed);
            if (inAgendaSection || isListItem) {
                const cleanItem = trimmed.replace(MinutesCreationModal.LIST_ITEM_PREFIX, '').trim();
                if (cleanItem.length > 3 && cleanItem.length < 200) {
                    agendaItems.push(cleanItem);
                }
            }
        }

        return [...new Set(agendaItems)].slice(0, 20).join('\n');
    }

    /** Regex for participant section headers */
    private static readonly PARTICIPANT_HEADER = /^(attendees|participants|present|members|team|people|invitees)/i;
    /** Regex for end of participant section */
    private static readonly PARTICIPANT_END = /^(agenda|apologies|absent|minutes|notes|action)/i;
    /** Regex for valid name pattern: 2-4 capitalized words */
    private static readonly NAME_PATTERN = /^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}$/;

    /**
     * Extract participant names from document text
     */
    private extractParticipantNames(text: string): string[] {
        const names: string[] = [];
        const lines = text.split('\n');
        let inParticipantSection = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (MinutesCreationModal.PARTICIPANT_HEADER.test(trimmed)) {
                inParticipantSection = true;
                continue;
            }

            if (inParticipantSection && MinutesCreationModal.PARTICIPANT_END.test(trimmed)) {
                break;
            }

            if (inParticipantSection) {
                const extractedNames = this.extractNamesFromLine(trimmed);
                names.push(...extractedNames);
            }
        }

        return [...new Set(names)].slice(0, 30);
    }

    /**
     * Extract names from a single line of text
     */
    private extractNamesFromLine(line: string): string[] {
        const cleanLine = line.replace(MinutesCreationModal.LIST_ITEM_PREFIX, '').trim();
        const names: string[] = [];

        for (const part of cleanLine.split(/[,;]/)) {
            const name = part
                .replace(/\s*[([].*?[)\]]/, '')  // Remove (Role) or [Role]
                .replace(/\s*[-–—].*$/, '')      // Remove - Present/Apologies
                .trim();

            if (MinutesCreationModal.NAME_PATTERN.test(name)) {
                names.push(name);
            }
        }

        return names;
    }

    private renderDocumentStatus(doc: DocumentItem, statusEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const behavior = this.plugin.settings.oversizedDocumentBehavior || 'ask';
        const maxChars = this.docController.getMaxChars();
        const isOversized = doc.charCount > maxChars;

        statusEl.empty();

        if (doc.isProcessing) {
            statusEl.setText(t?.extracting || 'Extracting...');
            return;
        }

        if (doc.error && doc.truncationChoice !== 'skip') {
            statusEl.addClass('error');
            statusEl.setText(doc.error);
            return;
        }

        if (isOversized && behavior === 'ask') {
            createTruncationWarning(
                statusEl,
                doc.charCount || 0,
                maxChars,
                doc.truncationChoice || 'truncate',
                getTruncationOptions(t),
                (choice) => {
                    const docId = this.getDocumentId(doc);
                    this.docController.setTruncationChoice(docId, choice);
                    this.refreshDocumentsSection();
                },
                t?.fullDocumentWarning,
                (count) => this.formatChars(count)
            );

            if (doc.truncationChoice === 'skip' && doc.error) {
                const skipEl = statusEl.createDiv({ cls: 'minutes-doc-skip-note' });
                skipEl.setText(doc.error);
            }
            return;
        }

        if (doc.extractedText) {
            statusEl.addClass('success');
            const chars = doc.extractedText.length;
            statusEl.setText((t?.documentExtracted || 'Extracted ({chars} chars)').replace('{chars}', String(chars)));
        }
    }



    private renderBulkTruncationControl(): void {
        if (!this.bulkTruncationEl) return;

        const t = this.plugin.t.minutes;
        const behavior = this.plugin.settings.oversizedDocumentBehavior || 'ask';

        if (behavior !== 'ask') {
            this.bulkTruncationEl.empty();
            return;
        }

        const oversized = this.docController.getOversizedDocuments();

        createBulkTruncationControls({
            containerEl: this.bulkTruncationEl,
            oversizedCount: oversized.length,
            maxChars: this.docController.getMaxChars(),
            options: getTruncationOptions(t),
            onApplyAll: (choice) => {
                this.state.bulkTruncationChoice = choice;
                this.docController.applyTruncationToAll(choice);
                this.refreshDocumentsSection();
            },
            countMessage: t?.oversizedDocuments,
            applyMessage: t?.applyToAll,
            selectedChoice: this.state.bulkTruncationChoice
        });
    }

    /**
     * Get the maximum document character limit from settings
     * Single source of truth for the limit value
     */
    private getMaxDocumentChars(): number {
        return this.plugin.settings.maxDocumentChars || DEFAULT_MAX_DOCUMENT_CHARS;
    }

    private getExcludedMessage(): string {
        return this.plugin.t.minutes?.excludedFromContext || 'Excluded from context (user choice)';
    }

    private formatChars(count: number): string {
        if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
        if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
        return String(count);
    }

    private getExtractedContextText(): string {
        return this.docController.getCombinedExtractedText();
    }

    // ==================== Dictionary ====================

    private async loadAvailableDictionaries(): Promise<void> {
        try {
            this.state.availableDictionaries = await this.dictionaryService.listDictionaries();
        } catch {
            console.warn('[AI Organiser] Failed to load dictionaries');
            this.state.availableDictionaries = [];
        }
    }

    private renderDictionarySection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        this.dictionarySectionEl = containerEl.createDiv({ cls: 'minutes-dictionary-section' });

        const header = this.dictionarySectionEl.createDiv({ cls: 'minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'minutes-section-icon' });
        setIcon(iconEl, 'book-text');
        header.createSpan({ text: t?.dictionarySection || 'Terminology Dictionary' });

        const desc = this.dictionarySectionEl.createDiv({ cls: 'minutes-section-desc' });
        desc.setText(t?.dictionaryDesc || 'Use a dictionary of names, terms, and acronyms for better transcription accuracy');

        // Dictionary selection dropdown
        const selectRow = this.dictionarySectionEl.createDiv({ cls: 'minutes-dictionary-select-row' });

        new Setting(selectRow)
            .setName(t?.dictionarySelect || 'Select dictionary')
            .addDropdown(dropdown => {
                dropdown.addOption('', t?.dictionaryNone || '(None)');
                dropdown.addOption('__new__', t?.dictionaryCreateNew || '+ Create new dictionary');

                for (const dict of this.state.availableDictionaries) {
                    const entryCount = dict.entries.length;
                    dropdown.addOption(dict.id, `${dict.name} (${entryCount} terms)`);
                }

                dropdown.setValue(this.state.selectedDictionaryId);
                dropdown.onChange(value => {
                    if (value === '__new__') {
                        void this.handleCreateNewDictionary();
                        dropdown.setValue(this.state.selectedDictionaryId);
                    } else {
                        this.state.selectedDictionaryId = value;
                        this.refreshDictionarySection();
                        // Trigger dictionary extraction offer if documents are already extracted
                        this.tryOfferDictionaryExtraction();
                    }
                });
            });

        // Show dictionary info if selected
        if (this.state.selectedDictionaryId) {
            const selectedDict = this.state.availableDictionaries.find(
                d => d.id === this.state.selectedDictionaryId
            );
            if (selectedDict) {
                this.renderDictionaryInfo(selectedDict);
            }
        }

        // Extract from documents button
        const documents = this.docController.getDocuments();
        if (documents.some(doc => doc.extractedText)) {
            const extractRow = this.dictionarySectionEl.createDiv({ cls: 'minutes-dictionary-actions' });

            const extractBtn = extractRow.createEl('button', {
                text: this.state.isExtractingDictionary
                    ? (this.state.dictionaryExtractionProgress || t?.dictionaryExtracting || 'Extracting terms...')
                    : (t?.dictionaryExtractFromDocs || 'Extract terms from documents')
            });

            if (!this.state.isExtractingDictionary) {
                const extractIcon = extractBtn.createSpan({ cls: 'minutes-btn-icon' });
                setIcon(extractIcon, 'sparkles');
                extractBtn.prepend(extractIcon);
            }

            extractBtn.disabled = this.state.isExtractingDictionary;
            extractBtn.addEventListener('click', () => void this.handleExtractDictionaryFromDocs());
        }
    }

    private renderDictionaryInfo(dictionary: Dictionary): void {
        if (!this.dictionarySectionEl) return;

        const infoEl = this.dictionarySectionEl.createDiv({ cls: 'minutes-dictionary-info' });

        if (dictionary.description) {
            infoEl.createDiv({ text: dictionary.description, cls: 'minutes-dictionary-description' });
        }

        // Show entry counts by category
        const counts: Record<string, number> = {};
        for (const entry of dictionary.entries) {
            counts[entry.category] = (counts[entry.category] || 0) + 1;
        }

        if (Object.keys(counts).length > 0) {
            const statsEl = infoEl.createDiv({ cls: 'minutes-dictionary-stats' });
            const categoryLabels: Record<string, string> = {
                person: 'People',
                acronym: 'Acronyms',
                project: 'Projects',
                organization: 'Organizations',
                term: 'Terms'
            };

            const statParts = Object.entries(counts)
                .map(([cat, count]) => `${count} ${categoryLabels[cat] || cat}`)
                .join(', ');
            statsEl.setText(statParts);
        }

        // Edit button
        const editBtn = infoEl.createEl('button', {
            text: this.plugin.t.minutes?.dictionaryEdit || 'Edit',
            cls: 'minutes-dictionary-edit-btn'
        });
        editBtn.addEventListener('click', () => void this.openDictionaryFile(dictionary.id));
    }

    private async handleCreateNewDictionary(): Promise<void> {
        const t = this.plugin.t.minutes;

        // Simple prompt for dictionary name
        const name = await this.promptForText(
            t?.dictionaryNamePrompt || 'Enter dictionary name:',
            t?.dictionaryNamePlaceholder || 'e.g., Acme Project Team'
        );

        if (!name) return;

        try {
            const newDict = this.dictionaryService.createEmptyDictionary(name);
            await this.dictionaryService.saveDictionary(newDict);

            // Reload dictionaries and select the new one
            await this.loadAvailableDictionaries();
            this.state.selectedDictionaryId = newDict.id;
            this.refreshDictionarySection();

            new Notice(`${t?.dictionaryCreated || 'Dictionary created'}: ${name}`);

            // Trigger dictionary extraction offer if documents are already extracted
            this.tryOfferDictionaryExtraction();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to create dictionary';
            new Notice(`${t?.dictionaryCreateFailed || 'Failed to create dictionary'}: ${message}`);
        }
    }

    private async promptForText(prompt: string, placeholder: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            let inputValue = '';

            modal.contentEl.createEl('p', { text: prompt });

            const input = modal.contentEl.createEl('input', {
                type: 'text',
                placeholder: placeholder
            });
            input.addClass('minutes-prompt-input');
            input.addEventListener('input', (e) => {
                inputValue = (e.target as HTMLInputElement).value;
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    modal.close();
                    resolve(inputValue.trim() || null);
                }
            });

            const footer = modal.contentEl.createDiv({ cls: 'minutes-prompt-footer' });

            const cancelBtn = footer.createEl('button', { text: this.plugin.t.common?.cancel || 'Cancel' });
            cancelBtn.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });

            const okBtn = footer.createEl('button', { text: this.plugin.t.common?.save || 'Save', cls: 'mod-cta' });
            okBtn.addEventListener('click', () => {
                modal.close();
                resolve(inputValue.trim() || null);
            });

            modal.open();
            input.focus();
        });
    }

    private async handleExtractDictionaryFromDocs(): Promise<void> {
        const t = this.plugin.t.minutes;

        // Check if we have extracted document content
        const docContent = this.getExtractedContextText();
        if (!docContent) {
            new Notice(t?.dictionaryNoDocsExtracted || 'Extract document content first');
            return;
        }

        // Check if dictionary is selected or create new
        if (!this.state.selectedDictionaryId) {
            const createNew = await this.confirmAction(
                t?.dictionaryCreatePrompt || 'No dictionary selected. Create a new one?'
            );
            if (!createNew) return;

            await this.handleCreateNewDictionary();
            if (!this.state.selectedDictionaryId) return;
        }

        this.state.isExtractingDictionary = true;
        this.state.dictionaryExtractionProgress = t?.dictionaryExtracting || 'Extracting terms...';
        this.refreshDictionarySection();

        try {
            // Build prompt for extraction
            const extractionPrompt = this.dictionaryService.buildExtractionPrompt();
            const fullPrompt = `${extractionPrompt}\n\n--- DOCUMENT CONTENT ---\n\n${docContent}`;

            // Call LLM
            const response = await withBusyIndicator(this.plugin, () => this.plugin.llmService.summarizeText(fullPrompt));
            if (!response.success || !response.content) {
                throw new Error(response.error || 'Extraction failed');
            }

            // Parse response
            const parseResult = this.dictionaryService.parseExtractionResponse(response.content);
            if (!parseResult.success || !parseResult.entries) {
                throw new Error(parseResult.error || 'Failed to parse extracted terms');
            }

            // Add entries to dictionary (deduplication happens in addEntries)
            const updatedDict = await this.dictionaryService.addEntries(
                this.state.selectedDictionaryId,
                parseResult.entries
            );

            if (updatedDict) {
                // Reload to show updated counts
                await this.loadAvailableDictionaries();

                const newCount = parseResult.entries.length;
                new Notice(
                    (t?.dictionaryExtracted || 'Extracted {count} terms')
                        .replace('{count}', String(newCount))
                );
            }

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`${t?.dictionaryExtractionFailed || 'Extraction failed'}: ${message}`);
        } finally {
            this.state.isExtractingDictionary = false;
            this.state.dictionaryExtractionProgress = '';
            this.refreshDictionarySection();
        }
    }

    private async confirmAction(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);

            modal.contentEl.createEl('p', { text: message });

            const footer = modal.contentEl.createDiv({ cls: 'minutes-prompt-footer' });

            const cancelBtn = footer.createEl('button', { text: this.plugin.t.common?.cancel || 'Cancel' });
            cancelBtn.addEventListener('click', () => {
                modal.close();
                resolve(false);
            });

            const okBtn = footer.createEl('button', { text: this.plugin.t.common?.confirm || 'Confirm', cls: 'mod-cta' });
            okBtn.addEventListener('click', () => {
                modal.close();
                resolve(true);
            });

            modal.open();
        });
    }

    private async openDictionaryFile(dictionaryId: string): Promise<void> {
        const path = `${this.dictionaryService.getDictionariesFolder()}/${dictionaryId}.md`;
        const file = this.app.vault.getAbstractFileByPath(path);

        if (file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file);
            this.close();
        } else {
            new Notice(this.plugin.t.minutes?.dictionaryNotFound || 'Dictionary file not found');
        }
    }

    private refreshDictionarySection(): void {
        if (!this.dictionarySectionEl) return;

        // Remove and re-render
        const parent = this.dictionarySectionEl.parentElement;
        const nextSibling = this.dictionarySectionEl.nextSibling;
        this.dictionarySectionEl.remove();

        const newSection = document.createElement('div');
        if (nextSibling) {
            parent?.insertBefore(newSection, nextSibling);
        } else {
            parent?.appendChild(newSection);
        }

        // Re-render into a temp container, then replace
        const tempEl = createDiv();
        this.dictionarySectionEl = tempEl;
        this.renderDictionarySection(tempEl);

        // Move children to actual position
        if (this.dictionarySectionEl.firstChild) {
            newSection.replaceWith(this.dictionarySectionEl);
        } else {
            newSection.remove();
        }
    }

    private async getDictionaryContent(): Promise<string> {
        if (!this.state.selectedDictionaryId) {
            return '';
        }

        const dictionary = await this.dictionaryService.getDictionaryById(this.state.selectedDictionaryId);
        if (!dictionary) {
            return '';
        }

        return this.dictionaryService.formatForPrompt(dictionary);
    }
}

/**
 * Document picker modal for selecting vault documents
 */
class DocumentPickerModal extends FuzzySuggestModal<TFile> {
    private readonly files: TFile[];
    private readonly onSelect: (file: TFile) => void;

    constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onSelect = onSelect;
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.onSelect(file);
    }
}
