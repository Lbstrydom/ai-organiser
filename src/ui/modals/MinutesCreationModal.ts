import { App, FuzzySuggestModal, Modal, Notice, Platform, Setting, setIcon, setTooltip, TFile, normalizePath } from 'obsidian';
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
import { getAudioTranscriptionApiKey } from '../../services/apiKeyHelpers';
import { ParticipantListService, ParticipantList } from '../../services/participantListService';

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
    // Participant lists
    selectedParticipantListId: string;
    availableParticipantLists: ParticipantList[];
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
    private participantListService: ParticipantListService;
    private documentService: DocumentExtractionService;
    private docController!: DocumentHandlingController;
    private audioController!: AudioController;
    private dictController!: DictionaryController;
    private state: MinutesModalState;
    private transcriptTextArea: HTMLTextAreaElement | null = null;
    private agendaTextArea: HTMLTextAreaElement | null = null;
    private participantsTextArea: HTMLTextAreaElement | null = null;
    private titleInputEl: HTMLInputElement | null = null;
    private startTimeInputEl: HTMLInputElement | null = null;
    private endTimeInputEl: HTMLInputElement | null = null;
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
        this.participantListService = new ParticipantListService(app, getConfigFolderFullPath(plugin.settings));
        this.documentService = deps?.documentService ?? new DocumentExtractionService(app);

        this.state = {
            title: '',
            date: this.getTodayDate(),
            startTime: '',
            endTime: '',
            location: 'Microsoft Teams',
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
            bulkTruncationChoice: 'truncate',
            // Participant lists
            selectedParticipantListId: '',
            availableParticipantLists: []
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
            // Auto-extract detected documents so auto-fill can populate form fields
            await this.autoExtractDetectedDocuments();
            await this.loadAvailableDictionaries();
            await this.loadAvailableParticipantLists();
            this.renderContextDocumentsSection(contentEl);
            this.renderDictionarySection(contentEl);
            this.renderAudioTranscriptionSection(contentEl);
        }

        this.renderParticipantsSection(contentEl);
        this.renderAdvancedSection(contentEl);
        this.renderFooter(contentEl);

        await this.autoFillTranscriptFromActiveFile();

        // Check for existing transcript files matching detected audio
        if (!Platform.isMobile) {
            await this.autoLoadExistingTranscript();
        }

        // Auto-fill form fields from extracted documents (title, times, agenda, participants)
        if (!Platform.isMobile) {
            this.autoFillFromDocuments();
        }
    }

    private renderTopSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const topSection = containerEl.createDiv({ cls: 'minutes-section minutes-section-top' });

        new Setting(topSection)
            .setName(t?.fieldTitle || 'Meeting title')
            .addText(text => {
                text.setPlaceholder('Weekly sync')
                    .setValue(this.state.title)
                    .onChange(value => this.state.title = value.trim());
                this.titleInputEl = text.inputEl;
            });

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
                this.startTimeInputEl = text.inputEl;
            });

        new Setting(endCol)
            .setName(t?.fieldEndTime || 'End time')
            .addText(text => {
                text.inputEl.type = 'time';
                text.setValue(this.state.endTime).onChange(value => this.state.endTime = value);
                this.endTimeInputEl = text.inputEl;
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

        // Participant list dropdown
        if (this.state.availableParticipantLists.length > 0 || !Platform.isMobile) {
            new Setting(section)
                .setName(t?.participantListSelect || 'Select participant list')
                .addDropdown(dropdown => {
                    dropdown.addOption('', t?.participantListNone || '(None)');
                    dropdown.addOption('__new__', t?.participantListCreateNew || '+ Create new list');

                    for (const list of this.state.availableParticipantLists) {
                        dropdown.addOption(list.id, `${list.name} (${list.entries.length})`);
                    }

                    dropdown.setValue(this.state.selectedParticipantListId);
                    dropdown.onChange(async (value) => {
                        if (value === '__new__') {
                            await this.handleCreateNewParticipantList();
                            dropdown.setValue(this.state.selectedParticipantListId);
                        } else {
                            this.state.selectedParticipantListId = value;
                            if (value) {
                                await this.loadParticipantListIntoTextarea(value);
                            }
                        }
                    });
                });
        }

        // Save current button
        const actionsEl = section.createDiv({ cls: 'minutes-participants-actions' });
        const saveBtn = actionsEl.createEl('button', {
            text: t?.participantListSaveCurrent || 'Save as list',
            cls: 'mod-muted'
        });
        saveBtn.addEventListener('click', () => this.handleSaveCurrentParticipantList());

        // Label + description
        section.createEl('label', {
            text: t?.fieldParticipants || 'Participants',
            cls: 'setting-item-name'
        });
        section.createEl('p', {
            text: t?.fieldParticipantsDesc || 'One per line. Format: Name | Title | Company',
            cls: 'minutes-participants-desc'
        });

        // Full-width monospace textarea
        const textarea = section.createEl('textarea', {
            cls: 'minutes-participants-textarea'
        });
        textarea.rows = 6;
        textarea.value = this.state.participants;
        textarea.addEventListener('input', () => {
            this.state.participants = textarea.value;
        });
        this.participantsTextArea = textarea;
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

        // Get extracted context from documents before closing modal
        const contextDocuments = this.getExtractedContextText();
        const dictionaryContent = await this.getDictionaryContent();

        // Close modal so status bar spinner is visible during LLM call
        this.close();

        const notice = new Notice(this.plugin.t.minutes?.generating || 'Generating minutes...', 0);

        try {
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
        } catch (error) {
            notice.hide();
            console.error('[AI Organiser] Minutes generation error:', error);
            const message = error instanceof Error ? error.message : 'Failed to generate minutes';
            new Notice(`${this.plugin.t.minutes?.errorParsing || 'Failed to parse minutes response'}: ${message}`, 5000);
        }
    }

    private validateRequiredFields(): boolean {
        const missing: string[] = [];
        const t = this.plugin.t.minutes;

        if (!this.state.title.trim()) missing.push(t?.fieldTitle || 'Title');
        if (!this.state.transcript.trim()) missing.push(t?.fieldTranscript || 'Transcript');

        if (missing.length > 0) {
            new Notice(
                `${t?.errorMissingFields || 'Required'}: ${missing.join(', ')}`,
                4000
            );
            return false;
        }
        return true;
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

    /**
     * Check if an existing transcript file exists for any detected audio file.
     * Looks in the configured transcript folder for files whose name starts with the audio basename.
     * If found, loads the transcript content into the transcript field.
     */
    private async autoLoadExistingTranscript(): Promise<void> {
        if (this.state.transcript.trim()) return; // Already has content
        if (this.state.detectedAudioFiles.length === 0) return;

        const pluginFolder = this.plugin.settings.pluginFolder || 'AI-Organiser';
        const transcriptSubfolder = this.plugin.settings.transcriptFolder || 'Transcripts';
        const folder = normalizePath(`${pluginFolder}/${transcriptSubfolder}`);

        const folderAbstract = this.app.vault.getAbstractFileByPath(folder);
        if (!folderAbstract) return;

        // Get all files in the transcript folder
        const allFiles = this.app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));
        if (allFiles.length === 0) return;

        // Try to match each detected audio file to a transcript
        for (const audio of this.state.detectedAudioFiles) {
            const audioBasename = audio.resolvedFile
                ? audio.resolvedFile.basename
                : audio.displayName.replace(/\.[^.]+$/, '');

            // Sanitize the same way saveTranscriptToFile does
            const sanitized = audioBasename
                .replace(/[\\/:*?"<>|]/g, '-')
                .replace(/\s+/g, ' ')
                .trim();

            if (!sanitized) continue;

            // Find a transcript file whose name starts with the sanitized audio name
            const match = allFiles.find(f => f.basename.startsWith(sanitized));
            if (match) {
                try {
                    const content = await this.app.vault.read(match);
                    this.state.transcript = content;
                    if (this.transcriptTextArea) {
                        this.transcriptTextArea.value = content;
                    }
                    const t = this.plugin.t.minutes;
                    new Notice(
                        (t?.transcriptAutoLoaded || 'Loaded existing transcript: {name}')
                            .replace('{name}', match.basename)
                    );
                    return; // Stop after first match
                } catch {
                    // Ignore read errors
                }
            }
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

    /**
     * Silently extract all detected documents so auto-fill can read their text.
     * Runs before rendering so documents appear already extracted in the UI.
     */
    private async autoExtractDetectedDocuments(): Promise<void> {
        const documents = this.docController.getDocuments();
        if (documents.length === 0) return;

        await this.docController.extractAll();
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
        const provider = await this.getTranscriptionProvider();
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

    private async getTranscriptionProvider(): Promise<{ provider: 'openai' | 'groq'; apiKey: string } | null> {
        const result = await getAudioTranscriptionApiKey(this.plugin);
        if (result) {
            return { provider: result.provider, apiKey: result.key };
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

            this.tryAutoFillTitle(doc);
            this.tryAutoFillTimes(doc);
            this.tryAutoFillAgenda(doc);
            this.tryAutoFillParticipants(doc);
        }

        // Suggest participants from existing dictionary person entries (before extraction)
        this.suggestParticipantsFromExistingDictionary();

        // Offer dictionary extraction if dictionary is selected and we haven't offered yet
        this.tryOfferDictionaryExtraction();
    }

    /**
     * Check the currently selected dictionary for existing person entries
     * and suggest them as participants. Runs before extraction so participants
     * are populated from dictionaries built in previous sessions.
     */
    private suggestParticipantsFromExistingDictionary(): void {
        if (!this.state.selectedDictionaryId) return;

        const selectedDict = this.state.availableDictionaries.find(
            d => d.id === this.state.selectedDictionaryId
        );
        if (!selectedDict || selectedDict.entries.length === 0) return;

        this.suggestParticipantsFromDictionary(selectedDict.entries);
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

    /** Regex for meeting title patterns in document text */
    private static readonly TITLE_PATTERN = /^(?:meeting|subject|title|re|topic)\s*[:–—-]\s*(.+)/im;

    private tryAutoFillTitle(doc: DocumentItem): void {
        if (this.state.title.trim()) return; // Already has content

        const text = doc.extractedText || '';
        // Try explicit patterns first
        const match = MinutesCreationModal.TITLE_PATTERN.exec(text);
        if (match) {
            const title = match[1].trim().substring(0, 120);
            this.state.title = title;
            if (this.titleInputEl) this.titleInputEl.value = title;
            return;
        }

        // Fall back to first heading-like line (short, capitalized)
        const firstLines = text.split('\n').slice(0, 10);
        for (const line of firstLines) {
            const trimmed = line.trim();
            if (trimmed.length >= 5 && trimmed.length <= 120 && /^[A-Z]/.test(trimmed) && !trimmed.endsWith(':')) {
                this.state.title = trimmed;
                if (this.titleInputEl) this.titleInputEl.value = trimmed;
                return;
            }
        }
    }

    /** Regex for labeled start/end times */
    private static readonly START_TIME_PATTERN = /(?:start|begin|from)\s*[:–—-]?\s*(\d{1,2}:\d{2})\s*(?:am|pm|AM|PM)?/i;
    private static readonly END_TIME_PATTERN = /(?:end|finish|to|until)\s*[:–—-]?\s*(\d{1,2}:\d{2})\s*(?:am|pm|AM|PM)?/i;
    /** Regex for "HH:MM – HH:MM" range */
    private static readonly TIME_RANGE_PATTERN = /(\d{1,2}:\d{2})\s*(?:am|pm|AM|PM)?\s*[-–—]\s*(\d{1,2}:\d{2})\s*(?:am|pm|AM|PM)?/;

    private tryAutoFillTimes(doc: DocumentItem): void {
        if (this.state.startTime && this.state.endTime) return; // Both already filled

        const text = (doc.extractedText || '').substring(0, 2000); // Only check header area

        this.tryFillStartTime(text);
        this.tryFillEndTime(text);
        this.tryFillTimesFromRange(text);
    }

    private tryFillStartTime(text: string): void {
        if (this.state.startTime) return;
        const match = MinutesCreationModal.START_TIME_PATTERN.exec(text);
        if (match) {
            this.state.startTime = match[1];
            if (this.startTimeInputEl) this.startTimeInputEl.value = match[1];
        }
    }

    private tryFillEndTime(text: string): void {
        if (this.state.endTime) return;
        const match = MinutesCreationModal.END_TIME_PATTERN.exec(text);
        if (match) {
            this.state.endTime = match[1];
            if (this.endTimeInputEl) this.endTimeInputEl.value = match[1];
        }
    }

    private tryFillTimesFromRange(text: string): void {
        if (this.state.startTime && this.state.endTime) return;
        const match = MinutesCreationModal.TIME_RANGE_PATTERN.exec(text);
        if (!match) return;
        if (!this.state.startTime) {
            this.state.startTime = match[1];
            if (this.startTimeInputEl) this.startTimeInputEl.value = match[1];
        }
        if (!this.state.endTime) {
            this.state.endTime = match[2];
            if (this.endTimeInputEl) this.endTimeInputEl.value = match[2];
        }
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
     * Suggest participants from dictionary person entries
     * Appends to existing participants or fills empty field
     */
    private suggestParticipantsFromDictionary(entries: import('../../services/dictionaryService').DictionaryEntry[]): void {
        const personEntries = entries.filter(e => e.category === 'person');
        if (personEntries.length === 0) return;

        // Extract existing names (first column before |) for dedup
        const existingNames = new Set(
            this.state.participants.split('\n')
                .map(l => l.split('|')[0].trim().toLowerCase())
                .filter(Boolean)
        );

        const newNames = personEntries
            .map(e => {
                // Parse definition for title and organisation
                // Expected formats: "Title, Organisation" or "Title at Organisation" or just free text
                const def = e.definition || '';
                const { title, organisation } = this.parsePersonDefinition(def);
                return `${e.term} | ${title} | ${organisation}`;
            })
            .filter(name => !existingNames.has(name.split('|')[0].trim().toLowerCase()));

        if (newNames.length === 0) return;

        const separator = this.state.participants.trim() ? '\n' : '';
        this.state.participants = this.state.participants.trim() + separator + newNames.join('\n');
        if (this.participantsTextArea) {
            this.participantsTextArea.value = this.state.participants;
        }

        const t = this.plugin.t.minutes;
        new Notice(
            (t?.participantsSuggestedFromDictionary || 'Added {count} participants from dictionary')
                .replace('{count}', String(newNames.length))
        );
    }

    /**
     * Parse a person definition into title and organisation components.
     * Handles formats like "CEO, Hamina LNG" or "CEO at Hamina LNG" or free text.
     */
    private parsePersonDefinition(definition: string): { title: string; organisation: string } {
        if (!definition) return { title: '', organisation: '' };

        // Try "Title, Organisation" (most common in structured data)
        const commaMatch = definition.match(/^([^,]+),\s*(.+)$/);
        if (commaMatch) return { title: commaMatch[1].trim(), organisation: commaMatch[2].trim() };

        // Try "Title at Organisation"
        const atMatch = definition.match(/^(.+?)\s+at\s+(.+)$/i);
        if (atMatch) return { title: atMatch[1].trim(), organisation: atMatch[2].trim() };

        // Try "Title - Organisation"
        const dashMatch = definition.match(/^([^-]+)\s*-\s*(.+)$/);
        if (dashMatch) return { title: dashMatch[1].trim(), organisation: dashMatch[2].trim() };

        // Fallback: put entire definition as title
        return { title: definition.trim(), organisation: '' };
    }

    // --- Participant list management ---

    private async loadAvailableParticipantLists(): Promise<void> {
        try {
            this.state.availableParticipantLists = await this.participantListService.listParticipantLists();
        } catch {
            console.warn('[AI Organiser] Failed to load participant lists');
            this.state.availableParticipantLists = [];
        }
    }

    private async loadParticipantListIntoTextarea(listId: string): Promise<void> {
        const list = this.state.availableParticipantLists.find(l => l.id === listId);
        if (!list) return;

        this.state.participants = list.entries.join('\n');
        if (this.participantsTextArea) {
            this.participantsTextArea.value = this.state.participants;
        }

        const t = this.plugin.t.minutes;
        new Notice(
            (t?.participantListLoaded || 'Loaded {count} participants from list')
                .replace('{count}', String(list.entries.length))
        );
    }

    private async handleCreateNewParticipantList(): Promise<void> {
        const t = this.plugin.t.minutes;
        const name = await this.promptForText(
            t?.participantListNamePrompt || 'Enter list name',
            'e.g., Board Meeting Team'
        );
        if (!name) return;

        const entries = this.state.participants
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        try {
            const list = await this.participantListService.createParticipantList(name, entries);
            await this.loadAvailableParticipantLists();
            this.state.selectedParticipantListId = list.id;
            new Notice(
                (t?.participantListCreated || 'Created participant list: {name}')
                    .replace('{name}', name)
            );
        } catch (error) {
            console.error('[AI Organiser] Failed to create participant list:', error);
            new Notice('Failed to create participant list');
        }
    }

    private async handleSaveCurrentParticipantList(): Promise<void> {
        const t = this.plugin.t.minutes;
        const entries = this.state.participants
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        if (entries.length === 0) {
            new Notice(t?.fieldParticipants || 'No participants to save');
            return;
        }

        if (this.state.selectedParticipantListId) {
            // Update existing list
            const existing = this.state.availableParticipantLists.find(
                l => l.id === this.state.selectedParticipantListId
            );
            if (existing) {
                existing.entries = entries;
                await this.participantListService.save(existing);
                new Notice(
                    (t?.participantListSaved || 'Participant list saved: {name}')
                        .replace('{name}', existing.name)
                );
                return;
            }
        }

        // No list selected — prompt for name and create new
        await this.handleCreateNewParticipantList();
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
                        // Suggest person entries from newly selected dictionary
                        this.suggestParticipantsFromExistingDictionary();
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

        // Combine context documents + transcript for extraction
        const docContent = this.getExtractedContextText();
        const transcript = this.state.transcript.trim();
        const combinedContent = [docContent, transcript].filter(Boolean).join('\n\n---\n\n');

        console.log('[AI Organiser] Dictionary extraction - docContent:', docContent.length, 'transcript:', transcript.length, 'combined:', combinedContent.length);

        if (!combinedContent) {
            new Notice(t?.dictionaryNoDocsExtracted || 'Add documents or a transcript first');
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
            // Truncate to avoid token limits — 50K chars is plenty for term extraction
            const MAX_EXTRACTION_CHARS = 50000;
            const truncatedContent = combinedContent.length > MAX_EXTRACTION_CHARS
                ? combinedContent.substring(0, MAX_EXTRACTION_CHARS) + '\n\n[... content truncated for term extraction ...]'
                : combinedContent;
            const fullPrompt = this.dictionaryService.buildExtractionPrompt(truncatedContent);

            // Call LLM
            const response = await withBusyIndicator(this.plugin, () => this.plugin.llmService.summarizeText(fullPrompt));
            if (!response.success || !response.content) {
                throw new Error(response.error || 'Extraction failed');
            }

            console.log('[AI Organiser] Dictionary extraction - input chars:', truncatedContent.length, 'response length:', response.content.length);
            console.log('[AI Organiser] Dictionary extraction response preview:', response.content.substring(0, 1000));

            // Parse response
            const parseResult = this.dictionaryService.parseExtractionResponse(response.content);
            console.log('[AI Organiser] Dictionary parse result:', parseResult.success, 'entries:', parseResult.entries?.length, 'error:', parseResult.error);

            if (!parseResult.success || !parseResult.entries) {
                throw new Error(parseResult.error || 'Failed to parse extracted terms');
            }

            if (parseResult.entries.length === 0) {
                new Notice('No terms found in the documents. Check the developer console for details.', 5000);
                return;
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

                // Suggest person entries as participants if field is empty
                this.suggestParticipantsFromDictionary(parseResult.entries);
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
