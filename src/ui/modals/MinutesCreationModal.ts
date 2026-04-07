import { App, DropdownComponent, FuzzySuggestModal, Modal, Notice, Platform, Setting, setIcon, setTooltip, TFile, normalizePath } from 'obsidian';
import { logger } from '../../utils/logger';
import type AIOrganiserPlugin from '../../main';
import { MinutesService } from '../../services/minutesService';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import type { OutputAudience, ConfidentialityLevel } from '../../services/prompts/minutesPrompts';
import { detectEmbeddedAudio, DetectedContent } from '../../utils/embeddedContentDetector';
import { isRecordingSupported } from '../../services/audioRecordingService';
import { AudioRecorderModal } from './AudioRecorderModal';
import { DictionaryService, Dictionary } from '../../services/dictionaryService';
import { DocumentExtractionService } from '../../services/documentExtractionService';
import { getConfigFolderFullPath, getMinutesOutputFullPath, getTranscriptFullPath, resolveOutputPath } from '../../core/settings';
import {
    ALL_DOCUMENT_EXTENSIONS,
    DEFAULT_MAX_DOCUMENT_CHARS,
    MinutesStyle,
    TruncationChoice
} from '../../core/constants';
import type { MeetingContext as MeetingContextType } from '../../services/prompts/minutesPrompts';
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
import { FolderScopePickerModal } from './FolderScopePickerModal';
import { enableAutoExpand } from '../../utils/uiUtils';
import { validateTranscriptCompleteness } from '../../services/transcriptQualityService';
import { listen } from '../utils/domUtils';

// ContextDocument interface removed - using DocumentItem from DocumentHandlingController

interface MinutesModalState {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    /** Minutes style (Phase 2 TRA — replaces personaId + detailLevel) */
    minutesStyle: MinutesStyle;
    /** Meeting context — affects formality and emphasis */
    meetingContext: MeetingContextType;
    agenda: string;
    participants: string;
    transcript: string;
    dualOutput: boolean;
    obsidianTasks: boolean;
    useGTD: boolean;
    languageOverride: string;
    customInstructions: string;
    /** Previous minutes text to use as a style reference */
    styleReference: string;
    /** Filename loaded via Agenda > Load from vault (visual indicator) */
    agendaLoadedFilename: string;
    /** Filename loaded via Style reference > Load from vault (visual indicator) */
    styleReferenceLoadedFilename: string;
    /** Filename loaded via Transcript > Load from vault (visual indicator) */
    transcriptLoadedFilename: string;
    // Audio transcription
    detectedAudioFiles: DetectedContent[];
    isTranscribing: boolean;
    transcriptionProgress: string;
    transcriptionLanguage: string;
    /** Path where transcript was saved to disk (persistent link) */
    savedTranscriptPath: string;
    // Document context (managed by controller)
    // contextDocuments removed - access via docController
    // Dictionary
    selectedDictionaryId: string;
    availableDictionaries: Dictionary[];
    isExtractingDictionary: boolean;
    dictionaryExtractionProgress: string;
    dictionaryAutoExtractOffered: boolean;
    // Output folder
    outputFolder: string;
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
    private dateInputEl: HTMLInputElement | null = null;
    private startTimeInputEl: HTMLInputElement | null = null;
    private endTimeInputEl: HTMLInputElement | null = null;
    private locationInputEl: HTMLInputElement | null = null;
    private privacyWarningEl: HTMLElement | null = null;
    private audioSectionEl: HTMLElement | null = null;
    private documentsSectionEl: HTMLElement | null = null;
    private bulkTruncationEl: HTMLElement | null = null;
    private participantListDropdownEl: HTMLSelectElement | null = null;
    private dictionarySectionEl: HTMLElement | null = null;
    private styleDropdown: DropdownComponent | null = null;
    private meetingContextDropdown: DropdownComponent | null = null;
    private cleanups: (() => void)[] = [];

    constructor(app: App, plugin: AIOrganiserPlugin, deps?: MinutesModalDependencies) {
        super(app);
        this.plugin = plugin;
        // Support dependency injection for testing, with default implementations
        this.minutesService = deps?.minutesService ?? new MinutesService(plugin);
        this.dictionaryService = deps?.dictionaryService ?? new DictionaryService(app, getConfigFolderFullPath(plugin.settings));
        this.participantListService = new ParticipantListService(app, getMinutesOutputFullPath(plugin.settings));
        this.documentService = deps?.documentService ?? new DocumentExtractionService(app);

        this.state = {
            title: '',
            date: this.getTodayDate(),
            startTime: '',
            endTime: '',
            location: 'Microsoft Teams',
            minutesStyle: plugin.settings.minutesStyle || 'standard',
            meetingContext: 'internal',
            agenda: '',
            participants: '',
            transcript: '',
            dualOutput: false,
            obsidianTasks: plugin.settings.minutesObsidianTasksFormat,
            useGTD: plugin.settings.minutesGTDOverlay,
            languageOverride: 'auto',
            customInstructions: '',
            styleReference: '',
            agendaLoadedFilename: '',
            styleReferenceLoadedFilename: '',
            transcriptLoadedFilename: '',
            // Audio transcription
            detectedAudioFiles: [],
            isTranscribing: false,
            transcriptionProgress: '',
            transcriptionLanguage: 'auto',
            savedTranscriptPath: '',
            // Document context
            // contextDocuments removed - managed by docController
            // Dictionary
            selectedDictionaryId: '',
            availableDictionaries: [],
            isExtractingDictionary: false,
            dictionaryExtractionProgress: '',
            dictionaryAutoExtractOffered: false,
            // Output folder
            outputFolder: getMinutesOutputFullPath(this.plugin.settings),
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
        contentEl.addClass('ai-organiser-minutes-modal');

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

        // Record button renders on ALL platforms (mobile + desktop), even with zero detected audio
        this.renderRecordButton(contentEl);

        this.renderParticipantsSection(contentEl);
        this.renderAdvancedSection(contentEl);

        // Output folder field with folder picker button
        const outputFolderSetting = new Setting(contentEl)
            .setName(this.plugin.t.minutes?.outputFolderLabel || 'Output folder');

        const folderDisplayEl = outputFolderSetting.controlEl.createSpan({
            text: this.state.outputFolder || '—',
            cls: 'ai-organiser-folder-display'
        });
        folderDisplayEl.addClass('ai-organiser-mr-8');
        folderDisplayEl.addClass('ai-organiser-text-muted');

        outputFolderSetting.addButton(btn => btn
            .setButtonText(this.plugin.t.modals?.folderScopePicker?.selectButton || 'Select')
            .onClick(() => {
                const picker = new FolderScopePickerModal(
                    this.app,
                    this.plugin,
                    {
                        title: this.plugin.t.minutes?.outputFolderLabel || 'Output folder',
                        allowSkip: false,
                        allowNewFolder: true,
                        defaultFolder: this.state.outputFolder,
                        resolvePreview: (path) => resolveOutputPath(this.plugin.settings, path, 'Meetings'),
                        onSelect: (folder) => {
                            if (folder) {
                                this.state.outputFolder = folder;
                                folderDisplayEl.textContent = folder;
                            }
                        }
                    }
                );
                picker.open();
            }));

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
        const topSection = containerEl.createDiv({ cls: 'ai-organiser-minutes-section minutes-section-top' });

        new Setting(topSection)
            .setName(t?.fieldTitle || 'Meeting title')
            .addText(text => {
                text.setPlaceholder('Weekly sync meeting')
                    .setValue(this.state.title)
                    .onChange(value => this.state.title = value.trim());
                this.titleInputEl = text.inputEl;
            });

        const row = topSection.createDiv({ cls: 'ai-organiser-minutes-row' });
        const dateCol = row.createDiv({ cls: 'ai-organiser-minutes-col' });
        const startCol = row.createDiv({ cls: 'ai-organiser-minutes-col' });
        const endCol = row.createDiv({ cls: 'ai-organiser-minutes-col' });

        new Setting(dateCol)
            .setName(t?.fieldDate || 'Date')
            .addText(text => {
                text.inputEl.type = 'date';
                text.setValue(this.state.date).onChange(value => this.state.date = value);
                this.dateInputEl = text.inputEl;
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
            .addText(text => {
                text.setPlaceholder('Boardroom or Zoom')
                    .setValue(this.state.location)
                    .onChange(value => this.state.location = value.trim());
                this.locationInputEl = text.inputEl;
            });

        const st = this.plugin.t.settings?.minutes;
        new Setting(topSection)
            .setName(t?.fieldStyle || 'Minutes style')
            .setDesc(t?.fieldStyleDesc || 'Choose the output format')
            .addDropdown(dropdown => {
                dropdown.addOption('smart-brevity', st?.styleSmartBrevity || 'Smart Brevity \u2014 fast executive scan');
                dropdown.addOption('standard', st?.styleStandard || 'Standard \u2014 key points, decisions, actions');
                dropdown.addOption('detailed', st?.styleDetailed || 'Detailed \u2014 formal governance minutes');
                if (this.state.styleReference) {
                    dropdown.addOption('guided', st?.styleGuided || 'Guided by reference');
                }
                dropdown.setValue(this.state.minutesStyle);
                dropdown.onChange(value => {
                    this.state.minutesStyle = value as MinutesStyle;
                    // Auto-suggest board context for detailed
                    if (value === 'detailed' && this.state.meetingContext === 'internal') {
                        this.state.meetingContext = 'board';
                        if (this.meetingContextDropdown) this.meetingContextDropdown.setValue('board');
                    }
                });
                this.styleDropdown = dropdown;
            });

        new Setting(topSection)
            .setName(t?.fieldMeetingContext || 'Meeting context')
            .setDesc(t?.fieldMeetingContextDesc || 'Type of meeting \u2014 affects formality and emphasis')
            .addDropdown(dropdown => {
                dropdown.addOption('internal', t?.contextInternal || 'Internal team meeting');
                dropdown.addOption('board', t?.contextBoard || 'Board meeting');
                dropdown.addOption('external', t?.contextExternal || 'External / client meeting');
                dropdown.setValue(this.state.meetingContext);
                dropdown.onChange(value => {
                    this.state.meetingContext = value as MeetingContextType;
                });
                this.meetingContextDropdown = dropdown;
            });

        const agendaSetting = new Setting(topSection)
            .setName(t?.fieldAgenda || 'Agenda (one item per line)')
            .setDesc(t?.fieldAgendaDesc || 'Load an agenda document to auto-fill meeting details and agenda items');

        // Standalone status banner — inserted AFTER the setting element, not inside it
        const agendaStatusBanner = this.createStatusBanner();
        agendaSetting.settingEl.insertAdjacentElement('afterend', agendaStatusBanner);
        if (this.state.agendaLoadedFilename) {
            this.showStatusBanner(agendaStatusBanner, this.state.agendaLoadedFilename);
        }

        let agendaBtnEl: HTMLButtonElement | null = null;
        agendaSetting.addButton(btn => {
            agendaBtnEl = btn.buttonEl;
            this.configureLoadButton(btn.buttonEl, t?.fieldAgendaLoad || 'Load from vault');
            if (this.state.agendaLoadedFilename) {
                this.markButtonLoaded(btn.buttonEl, this.state.agendaLoadedFilename);
            }
            btn.onClick(async () => {
                await this.loadAgendaFromVault(agendaBtnEl, agendaStatusBanner);
            });
        });

        agendaSetting.addTextArea(text => {
                text.inputEl.rows = 4;
                text.inputEl.spellcheck = true;
                text.setValue(this.state.agenda);
                text.onChange(value => this.state.agenda = value);
                text.inputEl.addClass('ai-organiser-minutes-textarea');
                this.agendaTextArea = text.inputEl;
            });

        const transcriptSetting = new Setting(topSection)
            .setName(t?.fieldTranscript || 'Transcript')
            .setDesc(t?.fieldTranscriptDesc || 'Paste or edit the transcript text');

        // Standalone status banner — inserted AFTER the setting element, not inside it
        const transcriptStatusBanner = this.createStatusBanner();
        transcriptSetting.settingEl.insertAdjacentElement('afterend', transcriptStatusBanner);
        if (this.state.transcriptLoadedFilename) {
            this.showStatusBanner(transcriptStatusBanner, this.state.transcriptLoadedFilename);
        }

        transcriptSetting.addButton(btn => {
            const transcriptBtnEl = btn.buttonEl;
            this.configureLoadButton(btn.buttonEl, t?.fieldTranscriptLoad || 'Load from vault');
            if (this.state.transcriptLoadedFilename) {
                this.markButtonLoaded(btn.buttonEl, this.state.transcriptLoadedFilename);
            }
            btn.onClick(async () => {
                const file = await this.pickTranscriptFile();
                if (file) {
                    const loaded = await this.loadTranscriptFromFile(file);
                    if (loaded) {
                        this.state.transcriptLoadedFilename = file.name;
                        this.markButtonLoaded(transcriptBtnEl, file.name);
                        this.showStatusBanner(transcriptStatusBanner, file.name);
                    }
                }
            });
        });

        transcriptSetting.addTextArea(text => {
                text.inputEl.rows = 8;
                text.inputEl.spellcheck = true;
                text.setValue(this.state.transcript);
                text.onChange(value => this.state.transcript = value);
                text.inputEl.addClass('ai-organiser-minutes-textarea');
                enableAutoExpand(text.inputEl, 300);
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
            .setName(t?.fieldObsidianTasks || 'Obsidian tasks format')
            .setDesc(t?.fieldObsidianTasksDesc || 'Add actions as - [ ] checkboxes')
            .addToggle(toggle => {
                toggle.setValue(this.state.obsidianTasks);
                toggle.onChange(value => this.state.obsidianTasks = value);
            });

        new Setting(topSection)
            .setName(t?.fieldGTDOverlay || 'GTD action classification')
            .setDesc(t?.fieldGTDOverlayDesc || 'Classify actions by GTD context (@office, @home, etc.)')
            .addToggle(toggle => {
                toggle.setValue(this.state.useGTD);
                toggle.onChange(value => this.state.useGTD = value);
            });

        const warning = this.plugin.t.minutes?.privacyWarning;
        if (warning) {
            this.privacyWarningEl = topSection.createDiv({ cls: 'ai-organiser-minutes-warning' });
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
                    this.participantListDropdownEl = dropdown.selectEl;
                    this.populateParticipantListDropdown(dropdown);
                    dropdown.setValue(this.state.selectedParticipantListId);
                    dropdown.onChange((value) => {
                        if (value === '__new__') {
                            void this.handleCreateNewParticipantList().then(() => {
                                dropdown.setValue(this.state.selectedParticipantListId);
                            });
                        } else {
                            this.state.selectedParticipantListId = value;
                            if (value) {
                                void this.loadParticipantListIntoTextarea(value);
                            }
                        }
                    });
                });
        }

        // Save current button
        const actionsEl = section.createDiv({ cls: 'ai-organiser-minutes-participants-actions' });
        const saveBtn = actionsEl.createEl('button', {
            text: t?.participantListSaveCurrent || 'Save as list',
            cls: 'mod-muted'
        });
        this.cleanups.push(listen(saveBtn, 'click', () => { void this.handleSaveCurrentParticipantList(); }));

        // Label + description
        section.createEl('label', {
            text: t?.fieldParticipants || 'Participants',
            cls: 'setting-item-name'
        });
        section.createEl('p', {
            text: t?.fieldParticipantsDesc || 'One per line. Format: Name | Title | Company',
            cls: 'ai-organiser-minutes-participants-desc'
        });

        // Full-width monospace textarea
        const textarea = section.createEl('textarea', {
            cls: 'ai-organiser-minutes-participants-textarea'
        });
        textarea.rows = 6;
        textarea.spellcheck = true;
        textarea.value = this.state.participants;
        this.cleanups.push(listen(textarea, 'input', () => {
            this.state.participants = textarea.value;
        }));
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
                text.inputEl.spellcheck = true;
                text.setValue(this.state.customInstructions);
                text.onChange(value => this.state.customInstructions = value);
                text.inputEl.addClass('ai-organiser-minutes-textarea');
                enableAutoExpand(text.inputEl);
            });

        // --- Style Reference: paste or load previous minutes as a formatting example ---
        const styleRefSetting = new Setting(section)
            .setName(t?.fieldStyleReference || 'Style reference')
            .setDesc(t?.fieldStyleReferenceDesc || 'Paste or load a previous set of minutes — the AI will mimic its style');

        // Standalone status banner — inserted AFTER the setting element, not inside it
        const styleRefStatusBanner = this.createStatusBanner();
        styleRefSetting.settingEl.insertAdjacentElement('afterend', styleRefStatusBanner);
        if (this.state.styleReferenceLoadedFilename) {
            this.showStatusBanner(styleRefStatusBanner, this.state.styleReferenceLoadedFilename);
        }

        styleRefSetting.addButton(btn => {
            const styleRefBtnEl = btn.buttonEl;
            this.configureLoadButton(btn.buttonEl, t?.fieldStyleReferenceLoad || 'Load from vault');
            if (this.state.styleReferenceLoadedFilename) {
                this.markButtonLoaded(btn.buttonEl, this.state.styleReferenceLoadedFilename);
            }
            btn.onClick(async () => {
                const file = await this.pickStyleReferenceFile();
                if (file) {
                    this.state.styleReferenceLoadedFilename = file.name;

                    // Visual indicators: button text, setting description, and standalone banner
                    this.markButtonLoaded(styleRefBtnEl, file.name);
                    this.showStatusBanner(styleRefStatusBanner, file.name);

                    let content: string;
                    if (file.extension === 'md') {
                        content = await this.app.vault.read(file);
                    } else {
                        const result = await this.documentService.extractText(file);
                        if (!result.success || !result.text) {
                            new Notice(result.error || 'Failed to extract text from document');
                            return;
                        }
                        content = result.text;
                    }
                    this.state.styleReference = content;
                    const textArea = styleRefSetting.controlEl.querySelector<HTMLTextAreaElement>('textarea');
                    if (textArea) textArea.value = content;
                    this.updateStyleForReference();

                    new Notice(`${t?.fieldStyleReferenceLoaded || 'Loaded'}: ${file.basename}`, 2000);
                }
            });
        });

        styleRefSetting.addTextArea(text => {
            text.inputEl.rows = 4;
            text.inputEl.spellcheck = false;
            text.setPlaceholder(t?.fieldStyleReferencePlaceholder || 'Paste previous minutes here, or use the button to load from vault...');
            text.setValue(this.state.styleReference);
            text.onChange(value => {
                this.state.styleReference = value;
                this.updateStyleForReference();
            });
            text.inputEl.addClass('ai-organiser-minutes-textarea');
            enableAutoExpand(text.inputEl);
        });
    }

    private renderFooter(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const footer = containerEl.createDiv({ cls: 'ai-organiser-minutes-footer' });

        const cancelBtn = footer.createEl('button', { text: this.plugin.t.modals.cancelButton || 'Cancel' });
        this.cleanups.push(listen(cancelBtn, 'click', () => this.close()));

        const submitBtn = footer.createEl('button', {
            text: t?.submitButton || 'Create Minutes',
            cls: 'mod-cta'
        });
        this.cleanups.push(listen(submitBtn, 'click', () => void this.handleSubmit()));
    }

    private async handleSubmit(): Promise<void> {
        if (!this.validateRequiredFields()) {
            return;
        }

        // Transcript completeness check: warn or block if coverage is low
        if (this.state.startTime && this.state.endTime && this.state.transcript.trim()) {
            const durationMinutes = this.estimateMeetingDurationMinutes();
            if (durationMinutes > 0) {
                const wordCount = this.state.transcript.split(/\s+/).filter(w => w.length > 0).length;
                const completeness = validateTranscriptCompleteness(wordCount, durationMinutes);

                if (completeness.severity === 'block') {
                    // Show confirmation dialog — user can override to proceed
                    const proceed = await this.showCompletenessWarning(completeness.message);
                    if (!proceed) return;
                } else if (completeness.severity === 'warn') {
                    new Notice(completeness.message, 5000);
                }
            }
        }

        const agendaItems = this.state.agenda
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        // Auto-extract chair from participants (first entry with role containing "chair")
        const chairName = this.state.participants
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .reduce<string>((found, line) => {
                if (found) return found;
                const cleaned = line.replace(/^[-*]\s+/, '');
                const parts = cleaned.split('|').map(p => p.trim());
                if (parts.length >= 2 && /\bchair\b/i.test(parts[1])) return parts[0];
                const legacy = cleaned.match(/^(.+?)\s*\(([^)]+)\)/);
                if (legacy && /\bchair\b/i.test(legacy[2])) return legacy[1].trim();
                return '';
            }, '');

        const metadata = {
            title: this.state.title,
            date: this.state.date,
            startTime: this.state.startTime,
            endTime: this.state.endTime,
            timezone: this.plugin.settings.minutesDefaultTimezone,
            meetingContext: this.state.meetingContext,
            outputAudience: (this.state.dualOutput ? 'external' : 'internal') as OutputAudience,
            confidentialityLevel: 'internal' as ConfidentialityLevel,
            chair: chairName,
            location: this.state.location,
            agenda: agendaItems,
            dualOutput: this.state.dualOutput,
            obsidianTasksFormat: this.state.obsidianTasks,
            minuteTaker: 'AI Organiser'
        };

        const contextDocuments = this.getExtractedContextText();
        const dictionaryContent = await this.getDictionaryContent();

        // Disable modal inputs + show overlay while LLM is working
        // Keeps modal open so user can retry on failure without re-entering data
        const overlay = this.showGeneratingOverlay();

        try {
            const result = await this.minutesService.generateMinutes({
                metadata,
                participantsRaw: this.state.participants,
                transcript: this.state.transcript,
                minutesStyle: this.state.minutesStyle,
                outputFolder: resolveOutputPath(this.plugin.settings, this.state.outputFolder, 'Meetings'),
                savedTranscriptPath: this.state.savedTranscriptPath || undefined,
                customInstructions: this.state.customInstructions,
                languageOverride: this.state.languageOverride,
                contextDocuments: contextDocuments || undefined,
                dictionaryContent: dictionaryContent || undefined,
                styleReference: this.state.styleReference || undefined,
                useGTD: this.state.useGTD
            });

            this.close();
            new Notice(`${this.plugin.t.minutes?.saved || 'Minutes saved'}: ${result.filePath}`, 4000);
        } catch (error) {
            overlay.remove();
            logger.error('Minutes', 'Minutes generation error:', error);
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

    /**
     * Estimate meeting duration in minutes from startTime and endTime fields.
     * Returns 0 if times cannot be parsed.
     */
    private estimateMeetingDurationMinutes(): number {
        try {
            const [startH, startM] = this.state.startTime.split(':').map(Number);
            const [endH, endM] = this.state.endTime.split(':').map(Number);
            if (Number.isNaN(startH) || Number.isNaN(startM) || Number.isNaN(endH) || Number.isNaN(endM)) {
                return 0;
            }
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;
            const duration = endMinutes - startMinutes;
            return duration > 0 ? duration : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Show a confirmation dialog for low transcript coverage.
     * Returns true if user chooses to proceed, false to cancel.
     */
    private showCompletenessWarning(message: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const modal = new Modal(this.app);
            // i18n keys for these strings will be added in Phase 2 of TRA plan
            const t = this.plugin.t.minutes as Record<string, string> | undefined;
            modal.titleEl.setText(t?.['transcriptIncompleteBlock'] || 'Low transcript coverage');
            modal.contentEl.createEl('p', { text: message });
            modal.contentEl.createEl('p', {
                text: t?.['transcriptIncompleteConfirm'] ||
                    'Do you want to proceed anyway? The generated minutes may be incomplete.',
                cls: 'mod-warning'
            });

            const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
            btnRow.createEl('button', { text: t?.['cancelLabel'] || 'Cancel' })
                .addEventListener('click', () => { modal.close(); resolve(false); });
            const proceedBtn = btnRow.createEl('button', {
                text: t?.['proceedAnyway'] || 'Proceed anyway',
                cls: 'mod-warning'
            });
            proceedBtn.addEventListener('click', () => { modal.close(); resolve(true); });

            modal.onClose = () => resolve(false);
            modal.open();
        });
    }

    private updatePrivacyWarning(): void {
        if (!this.privacyWarningEl) return;
        const showWarning = this.state.dualOutput;
        this.privacyWarningEl.toggleClass('is-hidden', !showWarning);
    }

    /** Saved style before style-ref override, so we can restore it */
    private savedStyle: MinutesStyle | '' = '';

    /** Update style dropdown state based on whether a style reference is present.
     *  When a style reference is loaded, "Guided by reference" becomes available
     *  and is auto-selected. When removed, reverts to previous selection.
     */
    private updateStyleForReference(): void {
        const hasStyleRef = !!this.state.styleReference?.trim();
        if (this.styleDropdown) {
            const st = this.plugin.t.settings?.minutes;
            if (hasStyleRef) {
                // Save current selection so we can restore if style ref is removed
                if (!this.savedStyle) {
                    this.savedStyle = this.state.minutesStyle;
                }
                // Add guided option dynamically if not already present
                const existingOptions = this.styleDropdown.selectEl.querySelectorAll('option');
                const hasGuided = Array.from(existingOptions).some(opt => opt.value === 'guided');
                if (!hasGuided) {
                    this.styleDropdown.addOption('guided', st?.styleGuided || 'Guided by reference');
                }
                this.state.minutesStyle = 'guided';
                this.styleDropdown.setValue('guided');
            } else {
                // Remove guided option and restore previous selection
                const guidedOption = this.styleDropdown.selectEl.querySelector('option[value="guided"]');
                if (guidedOption) guidedOption.remove();
                if (this.savedStyle && this.savedStyle !== 'guided') {
                    this.state.minutesStyle = this.savedStyle;
                    this.styleDropdown.setValue(this.savedStyle);
                    this.savedStyle = '';
                } else {
                    this.state.minutesStyle = 'standard';
                    this.styleDropdown.setValue('standard');
                    this.savedStyle = '';
                }
            }
        }
    }

    /**
     * Show a translucent overlay with spinner while the LLM generates minutes.
     * Returns the overlay element so it can be removed on failure.
     */
    private showGeneratingOverlay(): HTMLElement {
        const overlay = this.contentEl.createDiv({ cls: 'ai-organiser-minutes-generating-overlay' });
        const spinner = overlay.createDiv({ cls: 'ai-organiser-minutes-generating-spinner' });
        spinner.createEl('span', {
            text: this.plugin.t.minutes?.generating || 'Generating minutes...'
        });
        return overlay;
    }

    private createCollapsible(containerEl: HTMLElement, title: string): HTMLElement {
        const details = containerEl.createEl('details', { cls: 'ai-organiser-minutes-collapsible' });
        details.open = false;
        const summary = details.createEl('summary', { text: title });
        summary.addClass('ai-organiser-minutes-collapsible-summary');
        const inner = details.createDiv({ cls: 'ai-organiser-minutes-collapsible-content' });
        return inner;
    }

    private async autoFillTranscriptFromActiveFile(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !(activeFile instanceof TFile)) {
            return;
        }

        // Strategy 1: Active file IS a transcript file (legacy transcripts folder or meetings folder)
        const transcriptFolder = getTranscriptFullPath(this.plugin.settings);
        const meetingsFolder = resolveOutputPath(this.plugin.settings, this.state.outputFolder, 'Meetings');
        const isInTranscriptFolder = activeFile.path.startsWith(transcriptFolder);
        const isTranscriptInMeetings = activeFile.path.startsWith(meetingsFolder) &&
            activeFile.basename.includes('— Transcript');

        if (isInTranscriptFolder || isTranscriptInMeetings) {
            try {
                const content = await this.app.vault.read(activeFile);
                this.state.transcript = content;
                this.state.savedTranscriptPath = activeFile.path;
                if (this.transcriptTextArea) {
                    this.transcriptTextArea.value = content;
                }
                return;
            } catch {
                // Fall through to Strategy 2
            }
        }

        // Strategy 2: Active file has a transcript: wikilink in frontmatter (from previous minutes)
        const cache = this.app.metadataCache.getFileCache(activeFile);
        const transcriptLink = cache?.frontmatter?.transcript;
        if (transcriptLink && typeof transcriptLink === 'string') {
            // Extract wikilink target: "[[Some Name]]" → "Some Name"
            const wikiMatch = transcriptLink.match(/\[\[([^\]]+)\]\]/);
            if (wikiMatch) {
                const linkTarget = wikiMatch[1];
                const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, activeFile.path);
                if (resolved && resolved instanceof TFile) {
                    try {
                        const content = await this.app.vault.read(resolved);
                        this.state.transcript = content;
                        this.state.savedTranscriptPath = resolved.path;
                        if (this.transcriptTextArea) {
                            this.transcriptTextArea.value = content;
                        }
                        // Also auto-fill the title from the minutes frontmatter
                        const meetingTitle = cache?.frontmatter?.meeting_title;
                        if (meetingTitle && typeof meetingTitle === 'string' && !this.state.title.trim()) {
                            this.state.title = meetingTitle;
                        }
                        return;
                    } catch {
                        // Fall through
                    }
                }
            }
        }
    }

    /**
     * Check if an existing transcript file exists for any detected audio file.
     * 
     * Strategy priority (highest to lowest):
     * 1. **Audio source frontmatter** — strongest: transcript has audio_source linking to detected audio
     * 2. **Direct match by date+title** — strong: exact path in expected meeting subfolder
     * 3. **Audio name match** — moderate: transcript basename starts with audio filename
     * 4. **Date match** — weakest: single unambiguous transcript for today's date
     * 
     * Searches both the meetings output folder (where saveTranscriptToDisk saves)
     * and the legacy transcript folder for backward compatibility.
     * If found, loads the transcript content and stores the path for persistent linking.
     */
    private async autoLoadExistingTranscript(): Promise<void> {
        if (this.state.transcript.trim()) return; // Already has content
        if (this.state.detectedAudioFiles.length === 0) return;

        // Search TWO locations: the meetings output folder (primary) and the legacy transcript folder
        const meetingsFolder = normalizePath(resolveOutputPath(this.plugin.settings, this.state.outputFolder, 'Meetings'));
        const legacyFolder = normalizePath(getTranscriptFullPath(this.plugin.settings));

        const allFiles = this.app.vault.getFiles().filter(f =>
            f.path.startsWith(meetingsFolder + '/') ||
            (legacyFolder !== meetingsFolder && f.path.startsWith(legacyFolder + '/'))
        );
        if (allFiles.length === 0) return;

        // Strategy 1: Audio source frontmatter match — most reliable link
        // Transcripts saved by this plugin include audio_source frontmatter linking to the source audio
        const detectedAudioPaths = new Set(
            this.state.detectedAudioFiles
                .filter(a => a.resolvedFile)
                .map(a => a.resolvedFile!.path)
        );

        if (detectedAudioPaths.size > 0) {
            for (const file of allFiles) {
                const cache = this.app.metadataCache.getFileCache(file);
                const audioSource = cache?.frontmatter?.audio_source;
                if (audioSource && typeof audioSource === 'string') {
                    // Extract path from wikilink: "[[path/to/audio.mp3]]" → "path/to/audio.mp3"
                    const wikiMatch = audioSource.match(/\[\[([^\]]+)\]\]/);
                    const sourcePath = wikiMatch ? wikiMatch[1] : audioSource;
                    if (detectedAudioPaths.has(sourcePath)) {
                        if (await this.loadTranscriptFromFile(file)) {
                            this.markAudioAsTranscribed();
                            return;
                        }
                    }
                }
            }
        }

        // Strategy 2: Direct match by date+title
        const datePart = this.state.date || '';
        const titlePart = this.state.title?.trim() || '';
        if (datePart && titlePart) {
            const { sanitizeFileName } = await import('../../utils/minutesUtils');
            const safeTitle = sanitizeFileName(titlePart);
            // Direct match: look for the exact transcript file in the meeting subfolder
            const expectedPath = `${meetingsFolder}/${datePart} ${safeTitle}/${datePart} ${safeTitle} — Transcript.md`;
            const directMatch = allFiles.find(f => f.path === normalizePath(expectedPath));
            if (directMatch) {
                const loaded = await this.loadTranscriptFromFile(directMatch);
                if (loaded) return;
            }
        }

        // Strategy 3: Fallback — try to match by audio file name
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
                if (await this.loadTranscriptFromFile(match)) return;
            }
        }

        // Strategy 4: Last resort — search for any transcript file matching today's date
        // If exactly one exists, it's an unambiguous match
        if (datePart) {
            const dateTranscripts = allFiles.filter(f =>
                f.basename.endsWith('— Transcript') &&
                f.path.includes(`/${datePart} `)
            );
            if (dateTranscripts.length === 1) {
                const match = dateTranscripts[0];
                // Also extract the meeting title from the transcript filename
                // Pattern: "{date} {title} — Transcript"
                const titleMatch = match.basename.match(new RegExp(`^${datePart}\\s+(.+?)\\s+—\\s+Transcript$`));
                if (titleMatch && !this.state.title.trim()) {
                    this.state.title = titleMatch[1];
                    // Update title input if rendered
                    const titleInput = this.contentEl.querySelector('.minutes-section-top input[type="text"]') as HTMLInputElement;
                    if (titleInput) titleInput.value = titleMatch[1];
                }
                if (await this.loadTranscriptFromFile(match)) return;
            }
        }
    }

    /** Helper to load a transcript file into the state and UI.
     * Strips audio_source frontmatter before displaying (user only sees transcript text).
     */
    private async loadTranscriptFromFile(file: TFile): Promise<boolean> {
        try {
            let content = await this.app.vault.read(file);

            // Strip frontmatter (e.g., audio_source metadata) — user only needs transcript text
            const fmMatch = content.match(/^---\n[\s\S]*?\n---\n\n?/);
            if (fmMatch) {
                content = content.slice(fmMatch[0].length);
            }

            this.state.transcript = content;
            this.state.savedTranscriptPath = file.path;
            if (this.transcriptTextArea) {
                this.transcriptTextArea.value = content;
            }
            const t = this.plugin.t.minutes;
            new Notice(
                (t?.transcriptAutoLoaded || 'Loaded existing transcript: {name}')
                    .replace('{name}', file.basename)
            );
            return true;
        } catch {
            return false;
        }
    }

    /** Update audio section UI to show that a cached transcript was loaded */
    private markAudioAsTranscribed(): void {
        if (!this.audioSectionEl) return;
        const t = this.plugin.t.minutes;

        const buttons = this.audioSectionEl.querySelectorAll('.minutes-transcribe-btn');
        buttons.forEach(btn => {
            const buttonEl = btn as HTMLButtonElement;
            buttonEl.textContent = t?.transcriptCached || '✓ Transcript loaded';
            buttonEl.classList.add('ai-organiser-btn-loaded');
        });

        // Update section description to indicate cached transcript
        const desc = this.audioSectionEl.querySelector('.minutes-section-desc');
        if (desc) {
            desc.textContent = t?.audioTranscriptCached ||
                'Existing transcript loaded from cache. Click Transcribe to re-transcribe.';
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

    private renderRecordButton(containerEl: HTMLElement): void {
        if (!isRecordingSupported()) return;
        const t = this.plugin.t.recording;
        const section = containerEl.createDiv({ cls: 'ai-organiser-minutes-record-section' });
        const btn = section.createEl('button', {
            text: t?.record || 'Record Audio',
            cls: 'ai-organiser-minutes-record-btn mod-cta'
        });
        const iconSpan = btn.createSpan({ cls: 'ai-organiser-minutes-record-icon' });
        setIcon(iconSpan, 'mic');
        this.cleanups.push(listen(btn, 'click', () => {
            new AudioRecorderModal(this.app, this.plugin, {
                mode: 'minutes',
                transcriptionLanguage: this.state.transcriptionLanguage,
                onComplete: (result) => {
                    if (result.transcript) {
                        const sep = this.state.transcript ? '\n\n---\n\n' : '';
                        this.state.transcript += sep + result.transcript;
                        if (this.transcriptTextArea) {
                            this.transcriptTextArea.value = this.state.transcript;
                        }
                    }
                }
            }).open();
        }));
    }

    private renderAudioTranscriptionSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        // Only show if audio files detected and transcript is empty
        if (this.state.detectedAudioFiles.length === 0) {
            return;
        }

        this.audioSectionEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-audio-section' });

        const header = this.audioSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-minutes-section-icon' });
        setIcon(iconEl, 'mic');
        header.createSpan({ text: t?.audioTranscriptionSection || 'Audio Transcription' });

        const desc = this.audioSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-desc' });
        desc.setText(t?.audioDetected || 'Audio files detected in note. Transcribe to populate transcript.');

        // Language selection for transcription
        const langRow = this.audioSectionEl.createDiv({ cls: 'ai-organiser-minutes-audio-language-row' });
        langRow.createSpan({ text: t?.transcriptionLanguage || 'Audio language:', cls: 'ai-organiser-minutes-audio-language-label' });
        const langSelect = langRow.createEl('select', { cls: 'ai-organiser-minutes-audio-language-select' });

        for (const lang of COMMON_LANGUAGES) {
            const opt = langSelect.createEl('option', { value: lang.code });
            opt.textContent = getLanguageDisplayName(lang);
            if (lang.code === this.state.transcriptionLanguage) {
                opt.selected = true;
            }
        }

        this.cleanups.push(listen(langSelect, 'change', () => {
            this.state.transcriptionLanguage = langSelect.value;
        }));

        const listEl = this.audioSectionEl.createDiv({ cls: 'ai-organiser-minutes-audio-list' });

        for (const audioItem of this.state.detectedAudioFiles) {
            const itemEl = listEl.createDiv({ cls: 'ai-organiser-minutes-audio-item' });

            const nameEl = itemEl.createDiv({ cls: 'ai-organiser-minutes-audio-name' });
            const fileIcon = nameEl.createSpan({ cls: 'ai-organiser-minutes-audio-icon' });
            setIcon(fileIcon, 'file-audio');
            nameEl.createSpan({ text: audioItem.displayName });

            const transcribeBtn = itemEl.createEl('button', {
                text: t?.transcribeButton || 'Transcribe',
                cls: 'ai-organiser-minutes-transcribe-btn'
            });
            this.cleanups.push(listen(transcribeBtn, 'click', () => void this.handleTranscribeAudio(audioItem)));
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
            const { transcribeAudioWithFullWorkflow } = await import('../../services/audioTranscriptionService');

            const file = audioItem.resolvedFile;

            const result = await transcribeAudioWithFullWorkflow(
                this.app,
                file,
                {
                    provider: provider.provider,
                    apiKey: provider.apiKey,
                    language: this.getTranscriptionLanguageCode()
                },
                (progress) => {
                    this.state.transcriptionProgress = progress.message;
                    this.updateAudioSectionUI();
                }
            );

            if (!result.success || !result.transcript) {
                throw new Error(result.error || 'Transcription failed');
            }
            const transcript = result.transcript;

            // Surface any transcription quality warnings to the user
            if (result.warnings && result.warnings.length > 0) {
                for (const warning of result.warnings) {
                    new Notice(warning, 4000);
                }
            }

            // Update state and UI
            this.state.transcript = transcript;
            if (this.transcriptTextArea) {
                this.transcriptTextArea.value = transcript;
            }

            // Save transcript to disk with audio_source frontmatter for cache lookup
            const savedPath = await this.saveTranscriptToDisk(transcript, file);
            if (savedPath) {
                this.state.savedTranscriptPath = savedPath;
            }

            // Post-transcription cleanup: offer keep / compress / delete
            if (file) {
                const { offerPostTranscriptionCleanup } = await import('../../services/audioCleanupService');
                await offerPostTranscriptionCleanup(this.plugin, { file, transcriptionResult: result });
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

    /**
     * Save transcript to disk immediately after transcription so it's never lost.
     * Creates the meeting subfolder and saves the transcript file.
     * When audioFile is provided, adds audio_source frontmatter for reliable
     * auto-loading on subsequent modal opens (links transcript ↔ audio file).
     * Returns the saved path so it can be stored for persistent linking.
     */
    private async saveTranscriptToDisk(transcript: string, audioFile?: TFile): Promise<string | null> {
        try {
            const { ensureFolderExists, getAvailableFilePath, sanitizeFileName } = await import('../../utils/minutesUtils');
            const datePart = this.state.date || new Date().toISOString().slice(0, 10);
            const safeTitle = sanitizeFileName(this.state.title || 'Meeting');
            const outputFolder = resolveOutputPath(this.plugin.settings, this.state.outputFolder, 'Meetings');
            const meetingFolder = `${outputFolder}/${datePart} ${safeTitle}`;

            // Build content with frontmatter linking to audio source for cache lookup
            let content = transcript;
            if (audioFile) {
                content = `---\naudio_source: "[[${audioFile.path}]]"\ntranscribed_at: "${new Date().toISOString()}"\n---\n\n${transcript}`;
            }

            await ensureFolderExists(this.app.vault, meetingFolder);
            const transcriptPath = await getAvailableFilePath(
                this.app.vault, meetingFolder, `${datePart} ${safeTitle} — Transcript.md`
            );
            await this.app.vault.create(transcriptPath, content);

            if (this.plugin.settings.debugMode) {
                logger.debug('Minutes', `Transcript saved early: ${transcriptPath}`);
            }
            return transcriptPath;
        } catch (error) {
            // Don't block the transcription flow — log and continue
            logger.error('Minutes', 'Failed to save transcript to disk:', error);
            return null;
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

        this.documentsSectionEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-documents-section' });

        const header = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-minutes-section-icon' });
        setIcon(iconEl, 'file-text');
        header.createSpan({ text: t?.contextDocumentsSection || 'Context Documents' });

        const desc = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-desc' });
        desc.setText(t?.contextDocumentsDesc || 'Attach agendas, presentations, or spreadsheets to improve accuracy');

        // Bulk truncation control (rendered only when applicable)
        this.bulkTruncationEl = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-bulk-truncation' });
        this.renderBulkTruncationControl();

        // Document list
        const listEl = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-document-list' });
        this.renderDocumentList(listEl);

        // Add document button
        const addRow = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-add-document-row' });
        const addBtn = addRow.createEl('button', {
            text: t?.addDocument || 'Add Document'
        });
        const addIcon = addBtn.createSpan({ cls: 'ai-organiser-minutes-btn-icon' });
        setIcon(addIcon, 'plus');
        addBtn.prepend(addIcon);
        this.cleanups.push(listen(addBtn, 'click', () => this.openDocumentPicker()));

        // Extract all button (if documents exist)
        if (this.docController.getCount() > 0) {
            const extractBtn = addRow.createEl('button', {
                text: t?.extractAll || 'Extract All',
                cls: 'mod-cta'
            });
            this.cleanups.push(listen(extractBtn, 'click', () => void this.extractAllDocuments()));
        }
    }

    private renderDocumentList(listEl: HTMLElement): void {
        listEl.empty();
        const t = this.plugin.t.minutes;
        const documents = this.docController.getDocuments();

        if (documents.length === 0) {
            listEl.createDiv({
                text: t?.noDocumentsAttached || 'No documents attached',
                cls: 'ai-organiser-minutes-document-empty'
            });
            return;
        }

        for (const doc of documents) {
            const itemEl = listEl.createDiv({ cls: 'ai-organiser-minutes-document-item' });

            const infoEl = itemEl.createDiv({ cls: 'ai-organiser-minutes-document-info' });

            const nameRow = infoEl.createDiv({ cls: 'ai-organiser-minutes-document-name' });
            const fileIcon = nameRow.createSpan({ cls: 'ai-organiser-minutes-document-icon' });
            const extension = doc.file?.extension || doc.name.split('.').pop() || '';
            setIcon(fileIcon, this.getDocumentIcon(extension));
            nameRow.createSpan({ text: doc.name });

            // Status
            const statusEl = infoEl.createDiv({ cls: 'ai-organiser-minutes-document-status' });
            this.renderDocumentStatus(doc, statusEl);

            // Actions
            const actionsEl = itemEl.createDiv({ cls: 'ai-organiser-minutes-document-actions' });

            if (!doc.extractedText && !doc.isProcessing && !doc.error) {
                const extractBtn = actionsEl.createEl('button', { text: 'Extract' });
                this.cleanups.push(listen(extractBtn, 'click', () => void this.extractDocumentFromUI(doc)));
            }

            const removeBtn = actionsEl.createEl('button', { cls: 'ai-organiser-minutes-document-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.setAttribute('aria-label', t?.removeDocument || 'Remove');
            this.cleanups.push(listen(removeBtn, 'click', () => this.removeDocumentFromUI(doc)));
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
            logger.error('Minutes', 'Failed to open document picker:', error);
            new Notice('Failed to open document picker');
        }
    }

    /**
     * Opens a vault file picker for style reference documents.
     * Accepts markdown, Office documents (docx, xlsx, pptx, txt, rtf), and PDFs.
     * Returns the selected TFile or null if cancelled.
     */
    private pickStyleReferenceFile(): Promise<TFile | null> {
        const allowedExtensions = new Set(['md', ...ALL_DOCUMENT_EXTENSIONS]);
        const files = this.app.vault.getFiles()
            .filter(f => allowedExtensions.has(f.extension.toLowerCase()))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
        return this.openFilePicker(files);
    }

    /**
     * Opens a vault file picker for transcript files (markdown only).
     * Sorted by most recently modified. Returns the selected TFile or null if cancelled.
     */
    private pickTranscriptFile(): Promise<TFile | null> {
        const files = this.app.vault.getFiles()
            .filter(f => f.extension.toLowerCase() === 'md')
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
        return this.openFilePicker(files);
    }

    /** Shared file picker helper — opens DocumentPickerModal with settle/close safety */
    private openFilePicker(files: TFile[]): Promise<TFile | null> {
        return new Promise((resolve) => {
            if (files.length === 0) {
                new Notice(this.plugin.t.messages?.noMdFiles || 'No files found');
                resolve(null);
                return;
            }
            let settled = false;
            const settle = (file: TFile | null): void => {
                if (settled) return;
                settled = true;
                resolve(file);
            };
            const picker = new DocumentPickerModal(this.app, files, (file) => {
                settle(file);
            });
            const origClose = picker.onClose.bind(picker);
            picker.onClose = () => {
                origClose();
                // Defer: Obsidian's SuggestModal calls close() BEFORE onChooseItem(),
                // so we must wait a tick to let onSelect resolve first.
                setTimeout(() => settle(null), 50);
            };
            picker.open();
        });
    }

    /**
     * Loads an agenda document from the vault, extracts text,
     * then uses the LLM to extract meeting metadata (title, date, times, location)
     * and agenda items. Auto-fills the corresponding form fields.
     */
    private async loadAgendaFromVault(
        btnEl: HTMLButtonElement | null,
        statusBanner: HTMLElement | null = null
    ): Promise<void> {
        const t = this.plugin.t.minutes;
        const file = await this.pickStyleReferenceFile(); // reuse same picker
        if (!file) return;
        this.state.agendaLoadedFilename = file.name;
        if (btnEl) this.markButtonLoaded(btnEl, file.name);
        if (statusBanner) this.showStatusBanner(statusBanner, file.name);

        // Extract text from the file
        let documentText: string;
        if (file.extension === 'md') {
            documentText = await this.app.vault.read(file);
        } else {
            const result = await this.documentService.extractText(file);
            if (!result.success || !result.text) {
                new Notice(result.error || 'Failed to extract text from document');
                return;
            }
            documentText = result.text;
        }

        // Show loading indicator
        new Notice(t?.agendaExtracting || 'Extracting meeting details from document...', 3000);

        // Call LLM to extract structured meeting metadata + agenda
        try {
            const { buildAgendaExtractionPrompt, parseAgendaExtractionResponse } = await import('../../services/prompts/minutesPrompts');
            const prompt = buildAgendaExtractionPrompt(documentText.substring(0, 8000)); // Limit to first 8000 chars
            const result = await withBusyIndicator(this.plugin, () =>
                this.plugin.llmService.summarizeText(prompt)
            );

            if (result.success && result.content) {
                const extracted = parseAgendaExtractionResponse(result.content);
                this.applyAgendaExtraction(extracted);
                new Notice(t?.agendaExtracted || 'Meeting details extracted from document', 3000);
            } else {
                // Fallback: just paste the raw text as agenda
                this.state.agenda = documentText;
                if (this.agendaTextArea) this.agendaTextArea.value = documentText;
                new Notice(t?.agendaLoadedRaw || 'Document loaded (LLM extraction unavailable)', 3000);
            }

            this.state.agendaLoadedFilename = file.name;
            // Redundant update after LLM call (in case DOM was refreshed)
            if (btnEl) this.markButtonLoaded(btnEl, file.name);
            if (statusBanner) this.showStatusBanner(statusBanner, file.name);
        } catch (error) {
            logger.error('Minutes', 'Agenda extraction failed:', error);
            // Fallback: just paste the raw text as agenda
            this.state.agenda = documentText;
            if (this.agendaTextArea) this.agendaTextArea.value = documentText;
            new Notice(t?.agendaLoadedRaw || 'Document loaded (extraction failed — raw text pasted)', 3000);
            this.state.agendaLoadedFilename = file.name;
            // Still show the file indicator even on failure
            if (btnEl) this.markButtonLoaded(btnEl, file.name);
            if (statusBanner) this.showStatusBanner(statusBanner, file.name);
        }
    }

    /**
     * Applies extracted agenda metadata to the form fields.
     * Only fills fields that are currently empty and have extracted values.
     */
    private applyAgendaExtraction(extracted: import('../../services/prompts/minutesPrompts').AgendaExtractionResult): void {
        // User explicitly loaded an agenda document, so overwrite fields with
        // extracted values (including defaults like today's date). Only skip
        // fields the LLM returned empty (no data in the document).
        this.applyExtractedField('title', extracted.title, this.titleInputEl);
        this.applyExtractedField('date', extracted.date, this.dateInputEl);
        this.applyExtractedField('startTime', extracted.startTime, this.startTimeInputEl);
        this.applyExtractedField('endTime', extracted.endTime, this.endTimeInputEl);
        this.applyExtractedField('location', extracted.location, this.locationInputEl);

        // Participants — overwrite if extracted has entries
        if (extracted.participants.length > 0) {
            const participantText = extracted.participants.join('\n');
            this.state.participants = participantText;
            if (this.participantsTextArea) this.participantsTextArea.value = participantText;
        }

        // Agenda items — always fill (user explicitly loaded an agenda document)
        if (extracted.agendaItems.length > 0) {
            const agendaText = extracted.agendaItems.join('\n');
            this.state.agenda = agendaText;
            if (this.agendaTextArea) this.agendaTextArea.value = agendaText;
        }
    }

    /**
     * Sets a state field and its corresponding input element if the field is empty and
     * the extracted value is non-empty.
     */
    private applyFieldIfEmpty(
        field: 'title' | 'date' | 'startTime' | 'endTime' | 'location',
        value: string,
        inputEl: HTMLInputElement | null
    ): void {
        if (!value) return;
        const current = this.state[field];
        if (typeof current === 'string' && current.trim()) return; // Already has content
        this.state[field] = value;
        if (inputEl) inputEl.value = value;
    }

    /**
     * Overwrites a state field and its input element with an extracted value.
     * Skips only if the extracted value is empty (no data found in document).
     * Used for explicit user actions like loading an agenda document.
     */
    private applyExtractedField(
        field: 'title' | 'date' | 'startTime' | 'endTime' | 'location',
        value: string,
        inputEl: HTMLInputElement | null
    ): void {
        if (!value) return; // LLM didn't find this field in the document
        this.state[field] = value;
        if (inputEl) inputEl.value = value;
    }

    /**
     * Ensures "Load from vault" buttons render with both icon and text, even in themes
     * that force icon-only button variants.
     */
    private configureLoadButton(btnEl: HTMLButtonElement, label: string): void {
        btnEl.classList.remove('mod-icon', 'clickable-icon', 'ai-organiser-btn-loaded');
        btnEl.replaceChildren();

        const iconEl = document.createElement('span');
        setIcon(iconEl, 'folder-open');
        btnEl.appendChild(iconEl);

        const textEl = document.createElement('span');
        textEl.textContent = ` ${label}`;
        btnEl.appendChild(textEl);

        setTooltip(btnEl, label);
    }

    /**
     * Updates a button to show a green check + filename after loading a file.
     * This modifies the button element directly — guaranteed visible since the user clicks it.
     */
    private markButtonLoaded(btnEl: HTMLButtonElement, filename: string): void {
        const display = this.truncateFilename(filename, 28);
        btnEl.classList.remove('mod-icon', 'clickable-icon');
        btnEl.classList.add('ai-organiser-btn-loaded');
        btnEl.replaceChildren();

        const iconEl = document.createElement('span');
        setIcon(iconEl, 'check-circle');
        btnEl.appendChild(iconEl);

        const textEl = document.createElement('span');
        textEl.textContent = ` ${display}`;
        btnEl.appendChild(textEl);

        setTooltip(btnEl, filename);
    }

    /**
     * Creates a standalone status banner element — sits OUTSIDE the Setting component DOM.
     * Uses inline styles to be completely immune to theme CSS overrides.
     */
    private createStatusBanner(): HTMLDivElement {
        const banner = document.createElement('div');
        banner.addClass('ai-organiser-minutes-banner');
        return banner;
    }

    /**
     * Makes a status banner visible with the loaded filename.
     */
    private showStatusBanner(banner: HTMLElement, filename: string): void {
        const display = this.truncateFilename(filename, 40);
        banner.addClass('ai-organiser-block');
        banner.textContent = `\u2705 File loaded: ${display}`;
        logger.debug('Minutes', 'Status banner updated:', `${display} parentNode: ${banner.parentNode?.nodeName}`);
    }

    private truncateFilename(filename: string, maxLength: number): string {
        if (filename.length <= maxLength) return filename;
        return `${filename.substring(0, Math.max(1, maxLength - 3))}...`;
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
            logger.warn('Minutes', 'Extraction errors:', result.errors);
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
                // Only include non-empty columns
                const parts = [e.term];
                if (title || organisation) parts.push(title);
                if (organisation) parts.push(organisation);
                return parts.join(' | ');
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
            logger.warn('Minutes', 'Failed to load participant lists');
            this.state.availableParticipantLists = [];
        }
    }

    private loadParticipantListIntoTextarea(listId: string): void {
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
            this.refreshParticipantListDropdown();
            new Notice(
                (t?.participantListCreated || 'Created participant list: {name}')
                    .replace('{name}', name)
            );
        } catch (error) {
            logger.error('Minutes', 'Failed to create participant list:', error);
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
            new Notice(t?.participantListNoEntries || 'No participants to save');
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
                this.refreshParticipantListDropdown();
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

    private populateParticipantListDropdown(dropdown: import('obsidian').DropdownComponent): void {
        const t = this.plugin.t.minutes;
        dropdown.addOption('', t?.participantListNone || '(None)');
        dropdown.addOption('__new__', t?.participantListCreateNew || '+ Create new list');
        for (const list of this.state.availableParticipantLists) {
            dropdown.addOption(list.id, `${list.name} (${list.entries.length})`);
        }
    }

    private refreshParticipantListDropdown(): void {
        const el = this.participantListDropdownEl;
        if (!el) return;
        // Clear existing options and rebuild
        const currentValue = this.state.selectedParticipantListId;
        el.empty();
        const t = this.plugin.t.minutes;
        el.createEl('option', { text: t?.participantListNone || '(None)', attr: { value: '' } });
        el.createEl('option', { text: t?.participantListCreateNew || '+ Create new list', attr: { value: '__new__' } });
        for (const list of this.state.availableParticipantLists) {
            el.createEl('option', { text: `${list.name} (${list.entries.length})`, attr: { value: list.id } });
        }
        el.value = currentValue;
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
                const skipEl = statusEl.createDiv({ cls: 'ai-organiser-minutes-doc-skip-note' });
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
            logger.warn('Minutes', 'Failed to load dictionaries');
            this.state.availableDictionaries = [];
        }
    }

    private renderDictionarySection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        this.dictionarySectionEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-dictionary-section' });

        const header = this.dictionarySectionEl.createDiv({ cls: 'ai-organiser-minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-minutes-section-icon' });
        setIcon(iconEl, 'book-text');
        header.createSpan({ text: t?.dictionarySection || 'Terminology Dictionary' });

        const desc = this.dictionarySectionEl.createDiv({ cls: 'ai-organiser-minutes-section-desc' });
        desc.setText(t?.dictionaryDesc || 'Use a dictionary of names, terms, and acronyms for better transcription accuracy');

        // Dictionary selection dropdown
        const selectRow = this.dictionarySectionEl.createDiv({ cls: 'ai-organiser-minutes-dictionary-select-row' });

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
            const extractRow = this.dictionarySectionEl.createDiv({ cls: 'ai-organiser-minutes-dictionary-actions' });

            const extractBtn = extractRow.createEl('button', {
                text: this.state.isExtractingDictionary
                    ? (this.state.dictionaryExtractionProgress || t?.dictionaryExtracting || 'Extracting terms...')
                    : (t?.dictionaryExtractFromDocs || 'Extract terms from documents')
            });

            if (!this.state.isExtractingDictionary) {
                const extractIcon = extractBtn.createSpan({ cls: 'ai-organiser-minutes-btn-icon' });
                setIcon(extractIcon, 'sparkles');
                extractBtn.prepend(extractIcon);
            }

            extractBtn.disabled = this.state.isExtractingDictionary;
            this.cleanups.push(listen(extractBtn, 'click', () => void this.handleExtractDictionaryFromDocs()));
        }
    }

    private renderDictionaryInfo(dictionary: Dictionary): void {
        if (!this.dictionarySectionEl) return;

        const infoEl = this.dictionarySectionEl.createDiv({ cls: 'ai-organiser-minutes-dictionary-info' });

        if (dictionary.description) {
            infoEl.createDiv({ text: dictionary.description, cls: 'ai-organiser-minutes-dictionary-description' });
        }

        // Show entry counts by category
        const counts: Record<string, number> = {};
        for (const entry of dictionary.entries) {
            counts[entry.category] = (counts[entry.category] || 0) + 1;
        }

        if (Object.keys(counts).length > 0) {
            const statsEl = infoEl.createDiv({ cls: 'ai-organiser-minutes-dictionary-stats' });
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
            cls: 'ai-organiser-minutes-dictionary-edit-btn'
        });
        this.cleanups.push(listen(editBtn, 'click', () => void this.openDictionaryFile(dictionary.id)));
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
            input.addClass('ai-organiser-minutes-prompt-input');
            input.addEventListener('input', (e) => {
                inputValue = (e.target as HTMLInputElement).value;
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    modal.close();
                    resolve(inputValue.trim() || null);
                }
            });

            const footer = modal.contentEl.createDiv({ cls: 'ai-organiser-minutes-prompt-footer' });

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

        logger.debug('Minutes', `Dictionary extraction - docContent: ${docContent.length} transcript: ${transcript.length} combined: ${combinedContent.length}`);

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

            logger.debug('Minutes', `Dictionary extraction - input chars: ${truncatedContent.length} response length: ${response.content.length}`);
            logger.debug('Minutes', 'Dictionary extraction response preview:', response.content.substring(0, 1000));

            // Parse response
            const parseResult = this.dictionaryService.parseExtractionResponse(response.content);
            logger.debug('Minutes', `Dictionary parse result: ${parseResult.success} entries: ${parseResult.entries?.length} error: ${parseResult.error}`);

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

            const footer = modal.contentEl.createDiv({ cls: 'ai-organiser-minutes-prompt-footer' });

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

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
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
        // Do NOT call this.close() here — Obsidian's SuggestModal already
        // closes the modal after onChooseItem(). Calling close() again would
        // trigger onClose BEFORE onSelect has resolved, racing the Promise.
    }
}
