import { App, DropdownComponent, Modal, Notice, Platform, Setting, setIcon, setTooltip, TFile, normalizePath } from 'obsidian';
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
import { getScopedFiles } from '../utils/vaultFileScope';
import { SectionRegistryController } from '../../services/minutes/sectionRegistryController';
import type { MultiSegmentInput, SegmentInput, TranscriptItem } from '../../services/minutes/minutesTypes';
import { shouldUseLegacyPath } from '../../services/minutes/minutesTypes';
import { renderSectionAssignmentSelect } from '../components/SectionAssignmentSelect';
import { AudioAttachCoordinator } from '../coordinators/AudioAttachCoordinator';
import { renderAudioAttach, type AudioAttachHandle, type DetectedAudioPrompt } from '../components/AudioAttachHelper';
import type { AudioAttachItem, AudioAttachViewState, DetectedSpeaker, SpeakerMapping, SpeakerReviewState } from '../components/speakerReviewState';
import { canGenerateMinutes } from '../components/speakerReviewState';
import { renderSpeakerReview, type SpeakerReviewHandle } from '../components/SpeakerReviewPanel';
import {
    labelSpeakersTimed,
    transcriptionResultToTimedTranscript,
} from '../../services/speakerLabellingService';
import type { LabelledTimedTranscript } from '../../services/transcriptTypes';
import { getConfigFolderFullPath, getMinutesOutputFullPath, getTranscriptFullPath } from '../../core/settings';
import {
    ALL_DOCUMENT_EXTENSIONS,
    DEFAULT_MAX_DOCUMENT_CHARS,
    MinutesStyle,
    TruncationChoice
} from '../../core/constants';
import type { MeetingContext as MeetingContextType } from '../../services/prompts/minutesPrompts';
import { DocumentHandlingController, DocumentItem } from '../controllers/DocumentHandlingController';
import { DocumentMultiPickerModal } from './DocumentMultiPickerModal';
import { AudioController } from '../controllers/AudioController';
import { DictionaryController } from '../controllers/DictionaryController';
import { getTruncationOptions } from '../utils/truncation';
import {
    createTruncationWarning,
    createBulkTruncationControls
} from '../components/TruncationControls';
import { withBusyIndicator } from '../../utils/busyIndicator';
import { resolveSlideTierModel } from '../../services/specialistModelResolver';
import type { SummarizeOptions } from '../../services/types';
import { getAudioTranscriptionApiKey, getDeepgramApiKey } from '../../services/apiKeyHelpers';
import type { TranscriptionProvider } from '../../services/audioTranscriptionService';
import { DiarizationPrivacyModal } from './DiarizationPrivacyModal';
import {
    DEEPGRAM_LARGE_FILE_WARN_BYTES,
    type DiarizationResult,
} from '../../services/diarization/types';
import { ParticipantListService, ParticipantList } from '../../services/participantListService';
import { FolderScopePickerModal } from './FolderScopePickerModal';
import { enableAutoExpand } from '../../utils/uiUtils';
import { validateTranscriptCompleteness } from '../../services/transcriptQualityService';
import { sanitizeTranscriptPaste } from '../../utils/transcriptSanitizer';
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
    // Audio transcription
    /** Auto-detected from active note — read-only after onOpen; drives the "Use it/Ignore" prompt and cache lookup */
    detectedAudioFiles: DetectedContent[];
    /** F1b — items the user has actively attached (trio buttons or "Use it" accept) */
    audioAttachItems: AudioAttachItem[];
    /** F1b — user clicked "Ignore" on the auto-detect prompt; suppresses re-prompt for this modal session */
    detectedAudioFromNoteDismissed: boolean;
    isTranscribing: boolean;
    transcriptionProgress: string;
    transcriptionLanguage: string;
    /** F2c — speaker review state machine. Drives the panel + Generate Minutes CTA gate. */
    speakerReview: SpeakerReviewState;
    /** F2c — labelled transcript produced by labelSpeakersTimed() after transcription completes */
    labelledTranscript: LabelledTimedTranscript | null;
    /**
     * F4 — Documents detected in the active note, NOT yet attached. Drives
     * the chip prompt in the documents section. Cleared when user clicks
     * Attach all / Pick which / Ignore.
     */
    detectedDocumentsPreview: DocumentItem[];
    /** F4 — User clicked Ignore on the document chip; suppresses re-prompt this session */
    detectedDocumentsDismissed: boolean;
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
    private sectionRegistry!: SectionRegistryController;
    private controllersInitialized = false;
    /** Captured at modal open for scoped pickers (R2-M6 — never re-query workspace mid-session). */
    private sourceFileAtOpen: TFile | null = null;
    /**
     * Per-audio section assignment, keyed by `audioItem.resolvedFile?.path ?? audioItem.displayName`.
     * Default for any audio file is 'general'. Drives the per-row SectionAssignmentSelect
     * + routing of transcript output to the correct segment bucket.
     */
    private audioSectionAssignments = new Map<string, string>();
    /**
     * Loaded + transcribed transcripts grouped by section. Each entry's
     * `sectionId` matches a topic registry id (or 'general'). General is also
     * concatenated with the textarea content at build time.
     */
    private transcriptItems: TranscriptItem[] = [];
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

    /** Audio attach orchestration (plan F1b). Owns picker dispatch + preview lifecycle. */
    private audioCoordinator: AudioAttachCoordinator | null = null;
    /** Live handle to the rendered AudioAttachHelper — used for rerender on state changes. */
    private audioAttachHandle: AudioAttachHandle | null = null;
    /** Deepgram key resolved async on open (null when not configured / pre-resolution). */
    private deepgramKey: string | null = null;
    /** Modal-open flag — guards async resolution against onClose() race. */
    private modalIsOpen = false;
    /** DiarizationResult populated when the last transcribe used the diarized path. */
    private lastDiarizationResult: DiarizationResult | null = null;
    /**
     * Modal-scoped diarization opt-in. Lives on the modal (not the coordinator)
     * because `rerenderModal()` re-instantiates the coordinator and would otherwise
     * wipe the user's choice. After every coordinator creation, sync this value
     * to the coordinator so `shouldUseDiarization()` stays correct.
     */
    private diarizationOptedIn = false;
    /** Live handle to the SpeakerReviewPanel (F2c). */
    private speakerReviewHandle: SpeakerReviewHandle | null = null;
    /** Container for the SpeakerReviewPanel — kept across renders for in-place re-render */
    private speakerReviewContainerEl: HTMLElement | null = null;

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
            // Audio transcription
            detectedAudioFiles: [],
            // F1b — items the user has actively attached (via trio buttons OR via
            // "Use it" on the auto-detect prompt). Drives the AudioAttachHelper
            // render; distinct from detectedAudioFiles (which remains the
            // auto-detected-from-note holding area used for the prompt + cache lookup).
            audioAttachItems: [],
            detectedAudioFromNoteDismissed: false,
            // F2c — speaker review starts as 'not-required'. Transitions to
            // 'pending' (or 'skipped' / 'failed' on degraded paths) after
            // labelSpeakersTimed() completes post-transcription.
            speakerReview: { kind: 'not-required' },
            labelledTranscript: null,
            // F4 — populated by detectEmbeddedDocumentsForPreview() in onOpen.
            // Cleared on user Attach all / Pick which / Ignore.
            detectedDocumentsPreview: [],
            detectedDocumentsDismissed: false,
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

        // Init controllers once per modal session. onOpen() also runs for
        // rerenderModal() — recreating controllers there would wipe any
        // documents/audio/dictionary state the user just added (root cause of
        // the "Pick which → Attach selected → nothing appears" silent fail).
        // onClose() resets the flag so the next real open re-initializes.
        if (!this.controllersInitialized) {
            this.docController = new DocumentHandlingController(
                this.app,
                this.plugin,
                this.documentService
            );
            this.audioController = new AudioController(this.app);
            this.dictController = new DictionaryController(this.dictionaryService);
            this.sectionRegistry = new SectionRegistryController();
            this.sourceFileAtOpen = this.app.workspace.getActiveFile();
            this.controllersInitialized = true;
        }

        // Audio attach coordinator — owns picker dispatch, vault-import wiring,
        // and preview-URL lifecycle for this modal session. Disposed in onClose.
        // Imports go under AI-Organiser/Imports/ to keep them separate from
        // in-app recordings (AI-Organiser/Recordings/) — conceptually they're
        // different (device imports vs generated audio).
        this.audioCoordinator = new AudioAttachCoordinator(this.app, {
            importTargetFolder: 'AI-Organiser/Imports',
            translations: this.plugin.t,
        });
        // Restore modal-scoped opt-in after coordinator (re)creation — without
        // this line, `rerenderModal()` would wipe the user's "Identify speakers"
        // choice every time they attach a file.
        this.audioCoordinator.setDiarizationOptIn(this.diarizationOptedIn);

        // Diarization opt-in flag — async key resolution kicks off here, then
        // re-renders the audio section once known (or stays unchecked if no key).
        this.modalIsOpen = true;
        void this.resolveDeepgramKeyAndRefresh();

        const titleRow = contentEl.createDiv({ cls: 'ai-organiser-minutes-title-row' });
        titleRow.createEl('h2', {
            text: this.plugin.t.minutes?.modalTitle || 'Meeting Minutes'
        });
        // "+ Add topic" header button (D2 — always-visible topic creation entry
        // point so audio-only meetings still have a path to create topics).
        const addTopicBtn = titleRow.createEl('button', {
            cls: 'ai-organiser-minutes-add-topic-btn',
            text: this.plugin.t.minutes?.sections?.addTopicButton || '+ Add topic',
            attr: { 'data-testid': 'minutes-add-topic' },
        });
        this.cleanups.push(listen(addTopicBtn, 'click', () => this.openAddTopicPrompt()));
        if (this.sectionRegistry.hasTopics()) {
            this.renderTopicChips(titleRow);
        }

        // Audio detection is a pure vault-read + regex match — works on mobile
        // too. Split out from doc/dictionary detection (which uses officeparser
        // / file-system deps that don't exist on mobile) so mobile users can
        // still surface + transcribe audio embeds in their notes (round 10).
        await this.detectEmbeddedAudioOnly();

        // Document + dictionary detection is desktop-only.
        if (!Platform.isMobile) {
            // F4 — detect embedded documents from the active note BUT do NOT
            // silently extract them. The user sees a chip prompt in the
            // documents section and explicitly picks "Attach all", "Pick
            // which…", or "Ignore". This was Pat persona P1 — GTD knowledge
            // PDFs silently injected into a Q3 budget meeting destroyed trust.
            await this.detectEmbeddedDocumentsForPreview();
            await this.loadAvailableDictionaries();
            await this.loadAvailableParticipantLists();
        }

        // UX-03: top-of-modal Record affordance for users who opened the
        // modal seconds before a meeting — bottom Record button stays put.
        this.renderRecordBanner(contentEl);

        // Banner summarises whatever we detected — audio on any platform,
        // audio + docs on desktop.
        this.renderAutoDetectedBanner(contentEl);

        // Persona round 3 P2 #17 (2026-04-21): render the auto-detected
        // inputs — audio files + context docs — BEFORE the transcript
        // textarea so Pat's path is:
        //   "I see the banner → I see the audio → I click Transcribe"
        // instead of scrolling past the empty transcript field first.
        this.renderAudioTranscriptionSection(contentEl);
        // F2c — SpeakerReviewPanel slot. Lives directly below the audio
        // section so the user reviews speakers immediately after transcription
        // and before any minutes-generation work happens. Container persists
        // across renders so async transcription completions can update the
        // panel in-place without rebuilding the whole modal.
        this.speakerReviewContainerEl = contentEl.createDiv({
            cls: 'ai-organiser-speaker-review-slot',
        });
        this.renderSpeakerReviewSection();
        if (!Platform.isMobile) {
            this.renderContextDocumentsSection(contentEl);
        }

        this.renderTopSection(contentEl);

        // Dictionary stays after the textarea — it's a desktop-only preparatory
        // concept that only matters once you have text to transcribe.
        if (!Platform.isMobile) {
            this.renderDictionarySection(contentEl);
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
                        // No `resolvePreview` — the picker shows the user
                        // exactly the folder they're about to pick (matches
                        // where the minutes file will actually land). The
                        // previous resolver prepended the plugin output root,
                        // misleading users into thinking their pick was
                        // honored when it was silently re-rooted.
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

        // Check for existing transcript files matching detected audio. Uses
        // Obsidian vault API only — mobile-safe now that audio detection runs
        // on mobile too (round 10).
        await this.autoLoadExistingTranscript();

        // Document-based auto-fill is desktop-only — relies on officeparser.
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
                text.setPlaceholder('Boardroom or zoom')
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
        const loadedTranscriptNames = this.transcriptItems
            .filter((i) => i.sourceType === 'vault-file')
            .map((i) => i.displayName);
        if (loadedTranscriptNames.length === 1) {
            this.showStatusBanner(transcriptStatusBanner, loadedTranscriptNames[0]);
        } else if (loadedTranscriptNames.length > 1) {
            this.showStatusBannerText(
                transcriptStatusBanner,
                `${loadedTranscriptNames.length} transcripts loaded`,
            );
        }

        transcriptSetting.addButton(btn => {
            // Single button → multi-picker with in-note-first scoped header
            // (commit 33c89e1 "uniform 'in-note first, vault searchable' across
            // ALL pickers"). Accumulates into `transcriptItems[]`; the rerender
            // refreshes the banner + chips below the textarea.
            this.configureLoadButton(btn.buttonEl, t?.fieldTranscriptLoadText || t?.fieldTranscriptLoad || 'Load transcripts');
            if (loadedTranscriptNames.length === 1) {
                this.markButtonLoaded(btn.buttonEl, loadedTranscriptNames[0]);
            } else if (loadedTranscriptNames.length > 1) {
                this.markButtonLoaded(btn.buttonEl, `${loadedTranscriptNames.length} transcripts`);
            }
            btn.onClick(() => this.openTranscriptMultiPicker());
        });

        transcriptSetting.addTextArea(text => {
                text.inputEl.rows = 8;
                text.inputEl.spellcheck = true;
                text.setValue(sanitizeTranscriptPaste(this.state.transcript));
                text.onChange(value => this.state.transcript = sanitizeTranscriptPaste(value));
                text.inputEl.addClass('ai-organiser-minutes-textarea');
                enableAutoExpand(text.inputEl, 300);
                // Intercept paste to strip Word/Office HTML artifacts that
                // would otherwise survive into the LLM prompt and the output
                // note (file:///…/msohtmlclip1/…/clip_imageXXX.gif references
                // that Obsidian's CSP blocks, producing hundreds of console
                // errors and a UI freeze — user report 2026-04-23).
                text.inputEl.addEventListener('paste', (evt) => {
                    if (!evt.clipboardData) return;
                    const raw = evt.clipboardData.getData('text/plain');
                    if (!raw) return;
                    evt.preventDefault();
                    const cleaned = sanitizeTranscriptPaste(raw);
                    const el = text.inputEl;
                    const start = el.selectionStart ?? el.value.length;
                    const end = el.selectionEnd ?? el.value.length;
                    el.value = el.value.slice(0, start) + cleaned + el.value.slice(end);
                    el.selectionStart = el.selectionEnd = start + cleaned.length;
                    this.state.transcript = el.value;
                });
                this.transcriptTextArea = text.inputEl;
            });

        // Transcript chips — shows count of loaded transcripts. Renders below
        // textarea whenever items exist (with or without topics) so the user
        // can see what they've loaded after multi-picker selections.
        if (this.transcriptItems.length > 0) {
            const chipsRow = topSection.createDiv({ cls: 'ai-organiser-minutes-transcript-chips' });
            const generalCount = this.transcriptItems.filter((i) => i.sectionId === 'general').length
                + (this.state.transcript.trim() ? 1 : 0);
            if (generalCount > 0) {
                chipsRow.createSpan({
                    cls: 'ai-organiser-minutes-transcript-chip',
                    text: `General · ${generalCount}`,
                });
            }
            for (const topic of this.sectionRegistry.listTopics()) {
                const count = this.transcriptItems.filter((i) => i.sectionId === topic.id).length;
                if (count === 0) continue;
                chipsRow.createSpan({
                    cls: 'ai-organiser-minutes-transcript-chip ai-organiser-minutes-transcript-chip-topic',
                    text: `${SectionRegistryController.displayLabel(topic.name)} · ${count}`,
                });
            }
        }

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
            cls: 'mod-cta ai-organiser-minutes-submit'
        });
        this.cleanups.push(listen(submitBtn, 'click', () => void this.handleSubmit()));
        // F2c — initial gate check; refreshed by speaker-review state changes.
        this.refreshSubmitButtonGate();
    }

    private async handleSubmit(): Promise<void> {
        if (!this.validateRequiredFields()) {
            return;
        }

        // Compute the effective general-section transcript once — joins
        // pasted textarea content with any picker-loaded transcripts in
        // 'general'. This is what both the completeness check and the
        // legacy generation path consume; the multi-segment path also
        // uses the same helper internally via buildSegmentsFromState.
        const effectiveGeneralTranscript = this.buildEffectiveTranscript('general');

        // Transcript completeness check: warn or block if coverage is low
        if (this.state.startTime && this.state.endTime && effectiveGeneralTranscript.trim()) {
            const durationMinutes = this.estimateMeetingDurationMinutes();
            if (durationMinutes > 0) {
                const wordCount = effectiveGeneralTranscript.split(/\s+/).filter(w => w.length > 0).length;
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
        const abortController = new AbortController();
        const overlay = this.showGeneratingOverlay(abortController);
        const progressEl = overlay.querySelector<HTMLElement>('.ai-organiser-minutes-generating-progress');

        try {
            // F2c/F5 — derive the speaker-attribution inputs from the modal's
            // SpeakerReviewState. The fields are all optional on MinutesService
            // input: without them, the post-pass becomes a structured no-op
            // that emits a single warning instead of silently skipping.
            const speakerReviewKind = this.state.speakerReview.kind;
            const speakerMapping = speakerReviewKind === 'confirmed' ? this.state.speakerReview.mapping : undefined;
            const speakersVerified = speakerReviewKind === 'confirmed';
            const speakerDetectionStatus =
                speakerReviewKind === 'confirmed' ? 'detected' :
                speakerReviewKind === 'failed' ? 'failed' :
                speakerReviewKind === 'skipped' && this.state.speakerReview.reason === 'detection-failed' ? 'failed' :
                speakerReviewKind === 'skipped' && this.state.speakerReview.reason === 'detection-unavailable' ? 'unavailable' :
                speakerReviewKind === 'skipped' ? 'skipped' :
                'not-required';

            // Multi-segment dispatch (D7) — prune empty topics + check effective
            // segmentation before deciding which path. When the user has actively
            // populated ≥1 topic, run the multi-segment orchestrator.
            this.sectionRegistry.pruneEmptyTopics((topicId) =>
                this.docController.getDocuments().filter((d) => (d.sectionId || 'general') === topicId).length,
            );
            const docs = this.docController.getDocuments();
            const effectiveSections = new Set<string>(docs.map((d) => d.sectionId || 'general'));
            // Either paste or picker-loaded transcripts populate 'general'.
            if (effectiveGeneralTranscript.trim()) effectiveSections.add('general');
            for (const item of this.transcriptItems) {
                effectiveSections.add(item.sectionId || 'general');
            }
            const useLegacy = shouldUseLegacyPath({
                populatedTopicCount: this.sectionRegistry.listTopics().length,
                effectiveSectionIds: effectiveSections,
            });

            if (!useLegacy) {
                const outputFolderPath = this.getOutputFolder();
                const segments = this.buildSegmentsFromState();
                const multiInput: MultiSegmentInput & { outputFolder: string } = {
                    metadata,
                    participantsRaw: this.state.participants,
                    segments,
                    dictionaryContent: dictionaryContent || undefined,
                    styleReference: this.state.styleReference || undefined,
                    customInstructions: this.state.customInstructions,
                    languageOverride: this.state.languageOverride,
                    transcriptLanguageCode: this.state.labelledTranscript?.languageCode,
                    useGTD: this.state.useGTD,
                    outputFolder: outputFolderPath,
                };
                const msResult = await this.minutesService.generateMultiSegmentMinutes(multiInput, {
                    signal: abortController.signal,
                    onProgress: (current, total, name) => {
                        if (!progressEl) return;
                        progressEl.textContent =
                            (this.plugin.t.minutes?.progressChunkOf || 'Chunk {current} of {total} · {elapsed}')
                                .replace('{current}', String(current))
                                .replace('{total}', String(total))
                                .replace('{elapsed}', name);
                    },
                });
                if (!msResult.ok) {
                    overlay.remove();
                    if (msResult.error === 'cancelled') {
                        new Notice(this.plugin.t.minutes?.cancelled || 'Minutes generation cancelled.', 3000);
                    } else {
                        new Notice(`${this.plugin.t.minutes?.errorParsing || 'Failed to generate minutes'}: ${msResult.error}`, 5000);
                    }
                    return;
                }
                this.close();
                new Notice(`${this.plugin.t.minutes?.saved || 'Minutes saved'}: ${msResult.value.filePath}`, 4000);
                return;
            }

            // D3: hold the foreground gate so background indexing yields during generation.
            const result = await this.plugin.withForeground(() => this.minutesService.generateMinutes({
                metadata,
                participantsRaw: this.state.participants,
                transcript: effectiveGeneralTranscript,
                minutesStyle: this.state.minutesStyle,
                outputFolder: this.getOutputFolder(),
                savedTranscriptPath: this.state.savedTranscriptPath || undefined,
                customInstructions: this.state.customInstructions,
                languageOverride: this.state.languageOverride,
                contextDocuments: contextDocuments || undefined,
                dictionaryContent: dictionaryContent || undefined,
                styleReference: this.state.styleReference || undefined,
                useGTD: this.state.useGTD,
                // F2c/F5 — speaker-attribution inputs.
                labelledTranscript: this.state.labelledTranscript ?? undefined,
                transcriptLanguageCode: this.state.labelledTranscript?.languageCode,
                speakerMapping,
                speakersVerified,
                speakerDetectionStatus,
                // Phase 4: wire progress + cancel into the chunked loop.
                abortSignal: abortController.signal,
                onProgress: (current, total, elapsedMs) => {
                    if (!progressEl) return;
                    const secs = Math.floor(elapsedMs / 1000);
                    progressEl.textContent =
                        (this.plugin.t.minutes?.progressChunkOf || 'Chunk {current} of {total} · {elapsed}')
                            .replace('{current}', String(current))
                            .replace('{total}', String(total))
                            .replace('{elapsed}', `${secs}s`);
                },
                onSoftBudget: (elapsedMs, hardBudgetMs) => {
                    const secs = Math.floor(elapsedMs / 1000);
                    const hardMins = Math.round(hardBudgetMs / 60_000);
                    new Notice(
                        (this.plugin.t.minutes?.softBudgetNotice
                            || 'Still going — {elapsed} elapsed (hard cap at {hardMinutes}m)')
                            .replace('{elapsed}', `${secs}s`)
                            .replace('{hardMinutes}', String(hardMins)),
                        6000,
                    );
                },
            }));

            this.close();
            new Notice(`${this.plugin.t.minutes?.saved || 'Minutes saved'}: ${result.filePath}`, 4000);
        } catch (error) {
            overlay.remove();
            const isCancelled = abortController.signal.aborted;
            if (isCancelled) {
                new Notice(this.plugin.t.minutes?.cancelled || 'Minutes generation cancelled.', 3000);
            } else {
                logger.error('Minutes', 'Minutes generation error:', error);
                const message = error instanceof Error ? error.message : 'Failed to generate minutes';
                new Notice(`${this.plugin.t.minutes?.errorParsing || 'Failed to parse minutes response'}: ${message}`, 5000);
            }
        }
    }

    private validateRequiredFields(): boolean {
        const missing: string[] = [];
        const t = this.plugin.t.minutes;

        if (!this.state.title.trim()) missing.push(t?.fieldTitle || 'Title');
        // Transcript content can come from either the paste textarea OR
        // files loaded via the multi-picker (transcriptItems[]). Either
        // alone is sufficient — buildSegmentsFromState joins them.
        const hasTranscript = this.state.transcript.trim().length > 0
            || this.transcriptItems.length > 0;
        if (!hasTranscript) missing.push(t?.fieldTranscript || 'Transcript');

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
            const t = this.plugin.t.minutes as unknown as Record<string, string> | undefined;
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
    /**
     * Show the overlay with a live progress line + Cancel button wired to
     * the caller's AbortController (Phase 4). The `onProgress` callback on
     * the service updates `.ai-organiser-minutes-generating-progress` —
     * that selector is how generateMinutes() finds the element to write.
     */
    private showGeneratingOverlay(abortController?: AbortController): HTMLElement {
        const t = this.plugin.t.minutes;
        const overlay = this.contentEl.createDiv({ cls: 'ai-organiser-minutes-generating-overlay' });
        const spinner = overlay.createDiv({ cls: 'ai-organiser-minutes-generating-spinner' });
        spinner.createEl('span', { text: t?.generating || 'Generating minutes...' });

        // Live progress line — updated via onProgress from the service.
        overlay.createDiv({
            cls: 'ai-organiser-minutes-generating-progress',
            text: '',
        });

        if (abortController) {
            const cancelBtn = overlay.createEl('button', {
                cls: 'ai-organiser-minutes-generating-cancel mod-warning',
                text: t?.cancelButton || 'Cancel',
            });
            cancelBtn.addEventListener('click', () => {
                cancelBtn.disabled = true;
                cancelBtn.textContent = '…';
                abortController.abort();
            });
        }
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
        const meetingsFolder = this.getOutputFolder();
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
        const meetingsFolder = this.getOutputFolder();
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
            let content: string;

            if (file.extension.toLowerCase() === 'md') {
                content = await this.app.vault.read(file);

                // Strip frontmatter (e.g., audio_source metadata) — user only needs transcript text
                const fmMatch = content.match(/^---\n[\s\S]*?\n---\n\n?/);
                if (fmMatch) {
                    content = content.slice(fmMatch[0].length);
                }
            } else {
                // Route Word/Office/text documents through the extraction service —
                // vault.read() returns binary garbage for .docx/.xlsx/.pptx.
                const result = await this.documentService.extractText(file);
                if (!result.success || !result.text) {
                    new Notice(result.error || `Failed to extract text from ${file.name}`);
                    return false;
                }
                content = result.text;
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

    /**
     * Detect embedded audio files in the active note. Safe to run on mobile —
     * pure vault-read + regex match, no desktop-only dependencies.
     */
    private async detectEmbeddedAudioOnly(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        try {
            const content = await this.app.vault.read(activeFile);
            this.state.detectedAudioFiles = detectEmbeddedAudio(this.app, content, activeFile);
        } catch {
            // Ignore detection errors
        }
    }

    /**
     * Detect embedded PDFs and Office documents. Desktop-only — the document
     * extraction pipeline uses officeparser / fs deps that aren't available
     * on mobile.
     */
    /**
     * F4 — Detect embedded documents from the active note WITHOUT adding
     * them to the controller. Stored as a preview list that the docs
     * section renders as a chip prompt ("Detected N documents — Attach all
     * / Pick which… / Ignore"). User decides; nothing extracted silently.
     */
    private async detectEmbeddedDocumentsForPreview(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        try {
            const content = await this.app.vault.read(activeFile);
            this.state.detectedDocumentsPreview = this.docController.detectFromContent(content);
        } catch {
            // Ignore detection errors — chip prompt just doesn't appear.
        }
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
        this.cleanups.push(listen(btn, 'click', () => this.openRecorder()));
    }

    /**
     * UX-03 top-of-modal Record affordance. Renders a compact "Ready to
     * record now?" banner with a Record button so users opening the modal
     * seconds before a meeting don't have to scroll past Audio / Documents /
     * Transcript / Dictionary to find the bottom Record button.
     */
    private renderRecordBanner(containerEl: HTMLElement): void {
        if (!isRecordingSupported()) return;
        const tRec = this.plugin.t.recording;
        const tMin = this.plugin.t.minutes;
        const banner = containerEl.createDiv({ cls: 'ai-organiser-minutes-record-banner' });

        const iconWrap = banner.createSpan({ cls: 'ai-organiser-minutes-record-banner-icon' });
        setIcon(iconWrap, 'mic');

        banner.createSpan({
            text: tMin?.recordBannerLabel || 'Ready to record now?',
            cls: 'ai-organiser-minutes-record-banner-label'
        });

        const btn = banner.createEl('button', {
            text: tRec?.record || 'Record',
            cls: 'mod-cta ai-organiser-minutes-record-banner-btn'
        });
        this.cleanups.push(listen(btn, 'click', () => this.openRecorder()));
    }

    /**
     * Shared recorder-launch handler — used by both the top banner (UX-03)
     * and the bottom Record button. Single source of truth for the recorder
     * config + transcript-merge callback.
     */
    private openRecorder(): void {
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
    }

    // ============================================================================
    // F1b — Audio attach helper integration (Pat persona-test P0 fix)
    // ============================================================================

    /**
     * Render the AudioAttachHelper trio (Attach file / Pick from vault / Record)
     * + optional "Detected N audio files in this note" prompt chip. Always
     * rendered at the top of the audio section so users have an entry path
     * regardless of the active note's contents.
     */
    private renderAudioAttachHelper(container: HTMLElement): void {
        // Destroy any previous handle before re-rendering (idempotent).
        this.audioAttachHandle?.destroy();
        // Keep coordinator in sync with item count so canTranscribeNow() reflects
        // the multi-file constraint when diarization is opted in (R3 H1 / R4 H2).
        if (this.audioCoordinator) {
            this.audioCoordinator.setItemCount(this.state.detectedAudioFiles?.length ?? 0);
        }
        this.audioAttachHandle = renderAudioAttach(container, {
            state: this.deriveAudioAttachViewState(),
            detectedPrompt: this.deriveDetectedPrompt(),
            allowRecord: isRecordingSupported(),
            t: this.plugin.t,
            diarizationToggle: this.buildDiarizationToggleOptions(),
            onAttachIntent: () => void this.handleAttachIntent(),
            onPickVaultIntent: () => void this.handlePickVaultIntent(),
            onRecordIntent: () => this.openRecorder(),
            onDetectedAccept: () => this.handleDetectedAccept(),
            onDetectedDismiss: () => this.handleDetectedDismiss(),
            // F1b unused — handled by the legacy per-item list below. Will be
            // wired through the helper itself in F2 when state-machine adoption
            // covers all states.
            onReplaceIntent: () => { /* deferred to F2 */ },
            onTranscribeIntent: () => { /* deferred to F2 */ },
            onAbortIntent: () => { /* deferred to F2 */ },
            onRetryIntent: () => { /* deferred to F2 */ },
        });
    }

    /**
     * Derive the helper's view-state from current modal state. For F1b the
     * helper is only used for the trio + detected prompt, so we stay in the
     * `empty` kind — the existing per-file list handles the rest. The full
     * state machine adoption (`attached` / `transcribing` / `transcribed`)
     * lands in F2 when SpeakerReviewPanel needs the labelled transcript
     * threaded through.
     */
    private deriveAudioAttachViewState(): AudioAttachViewState {
        return { kind: 'empty' };
    }

    /**
     * Build the detected-audio prompt only when:
     *   1. There are auto-detected audio files from the active note,
     *   2. The user hasn't explicitly dismissed the prompt this session, and
     *   3. The user hasn't already taken any audio action.
     */
    private deriveDetectedPrompt(): DetectedAudioPrompt | undefined {
        if (this.state.detectedAudioFromNoteDismissed) return undefined;
        const detected = this.state.detectedAudioFiles;
        if (detected.length === 0) return undefined;
        return {
            count: detected.length,
            displayName: detected[0]?.displayName ?? '',
        };
    }

    /**
     * Picker → import → push as DetectedContent. Funnelling new attachments
     * through the existing `detectedAudioFiles` array keeps the per-item
     * Transcribe rendering working unchanged.
     */
    private async handleAttachIntent(): Promise<void> {
        if (!this.audioCoordinator) return;
        const outcome = await this.audioCoordinator.requestAttachFromDevice();
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'failed') {
            new Notice(this.plugin.t.minutes?.transcriptionFailed || 'Picker failed');
            return;
        }
        for (const source of outcome.sources) {
            const imported = await this.audioCoordinator.importToVault(source);
            if (!imported.ok) {
                new Notice(`${this.plugin.t.minutes?.transcriptionFailed || 'Failed'}: ${imported.error}`);
                continue;
            }
            this.injectVaultFileAsDetected(imported.value.file);
        }
        // Re-render the modal so the new files appear in the legacy list AND
        // re-render the helper so the prompt clears once items exist.
        this.rerenderModal();
    }

    private async handlePickVaultIntent(): Promise<void> {
        if (!this.audioCoordinator) return;
        const outcome = await this.audioCoordinator.requestVaultPick(this.sourceFileAtOpen);
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'failed') {
            new Notice(this.plugin.t.minutes?.transcriptionFailed || 'Picker failed');
            return;
        }
        for (const source of outcome.sources) {
            // Vault picks need no import — coordinator.importToVault returns the
            // existing file unchanged, but we still go through it for the
            // uniform ImportedAudio return so downstream wiring is consistent.
            const imported = await this.audioCoordinator.importToVault(source);
            if (imported.ok) this.injectVaultFileAsDetected(imported.value.file);
        }
        this.rerenderModal();
    }

    private handleDetectedAccept(): void {
        // "Use it" — files are already in detectedAudioFiles and rendered in
        // the list below; just dismiss the prompt so the chip disappears.
        this.state.detectedAudioFromNoteDismissed = true;
        this.audioAttachHandle?.rerender(
            this.deriveAudioAttachViewState(),
            this.deriveDetectedPrompt()
        );
    }

    private handleDetectedDismiss(): void {
        // "Ignore" — clear the auto-detected files entirely so they no longer
        // appear in the list below. User has explicitly said these aren't
        // wanted for this meeting.
        this.state.detectedAudioFiles = [];
        this.state.detectedAudioFromNoteDismissed = true;
        this.rerenderModal();
    }

    /**
     * Convert a vault TFile into the existing DetectedContent shape so it can
     * be appended to `detectedAudioFiles` and rendered by the legacy per-item
     * list. Idempotent — files already in the list are not added twice.
     */
    private injectVaultFileAsDetected(file: TFile): void {
        if (this.state.detectedAudioFiles.some((d) => d.resolvedFile?.path === file.path)) {
            return;
        }
        this.state.detectedAudioFiles.push({
            type: 'audio',
            originalText: `![[${file.path}]]`,
            url: file.path,
            displayName: file.name,
            isEmbedded: true,
            isExternal: false,
            resolvedFile: file,
            lineNumber: -1,
        });
    }

    /**
     * Re-render the modal contents. Cheaper than reopening — preserves field
     * focus where the editor allows it. Used after async picker/import flows
     * mutate state.
     */
    private rerenderModal(): void {
        // Re-run the body render. onOpen is the canonical builder; calling it
        // again rebuilds the DOM with the current state.
        void this.onOpen();
    }

    // ============================================================================
    // F2c — SpeakerReviewPanel integration
    // ============================================================================

    /**
     * Render (or re-render) the SpeakerReviewPanel into its persistent slot.
     * Called once during initial modal render and again after async events
     * that change `state.speakerReview` (transcription complete, labelling
     * complete, user confirm/skip).
     */
    private renderSpeakerReviewSection(): void {
        const slot = this.speakerReviewContainerEl;
        if (!slot) return;

        // Destroy any previous panel first (idempotent; clears listeners).
        this.speakerReviewHandle?.destroy();
        slot.empty();

        // `not-required` short-circuits to render nothing — saves a wrapper
        // div + listeners we'd never use.
        if (this.state.speakerReview.kind === 'not-required') {
            this.speakerReviewHandle = null;
            return;
        }

        // Preview handle: resolved from the first audio item's source via the
        // coordinator. When no items exist (e.g. transcript was pasted), pass
        // null so the panel suppresses preview controls (R1 H2 contract).
        const previewHandle = this.resolveSpeakerPreviewHandle();

        // Whether audio preview is offered at all — gated on timestampSource.
        const timestampsAvailable =
            (this.state.labelledTranscript?.timestampSource ?? 'none') === 'whisper-verbose-json';

        this.speakerReviewHandle = renderSpeakerReview(slot, {
            state: this.state.speakerReview,
            participants: this.parseParticipantsForReview(),
            preview: previewHandle,
            timestampsAvailable,
            t: this.plugin.t,
            onConfirm: (mapping) => this.handleSpeakerConfirm(mapping),
            onSkip: () => this.handleSpeakerSkip('user-skip'),
            onEditAfterConfirm: () => this.handleSpeakerEdit(),
        });
    }

    /**
     * Run the speaker-labelling LLM pre-pass against a fresh transcription
     * result and transition `speakerReview` into the appropriate state. Three
     * outcomes:
     *   - `pending` — ≥2 distinct speakers detected → show panel for user
     *     to confirm/rename
     *   - `not-required` — <2 distinct speakers → no review needed, CTA
     *     immediately re-enabled
     *   - `failed` / `skipped` — labelling threw or detection unavailable;
     *     CTA gated open with explanatory banner
     */
    private async runSpeakerLabelling(timed: ReturnType<typeof transcriptionResultToTimedTranscript>): Promise<void> {
        // Persist the underlying TimedTranscript so the panel can decide
        // whether to offer audio preview (timestampSource flag) and so
        // downstream MinutesService consumers can read the same structure.
        try {
            const participants = this.parseParticipantsForReview();
            const labelled = await labelSpeakersTimed(this.plugin, timed, participants);
            this.state.labelledTranscript = labelled;

            // Build DetectedSpeaker[] for the panel.
            const detected = this.buildDetectedSpeakersFromLabelled(labelled);
            if (detected.length < 2) {
                // One speaker (or zero) → review is trivially not needed.
                this.state.speakerReview = detected.length === 0
                    ? { kind: 'skipped', detected: [], reason: 'detection-failed' }
                    : { kind: 'not-required' };
            } else {
                this.state.speakerReview = { kind: 'pending', detected };
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.state.labelledTranscript = null;
            this.state.speakerReview = { kind: 'failed', detected: [], error: message };
            logger.warn('Minutes', `labelSpeakersTimed threw: ${message}`);
        }
        this.renderSpeakerReviewSection();
    }

    /**
     * Build a `DetectedSpeaker[]` from a `LabelledTimedTranscript` — one entry
     * per unique speaker, with first-utterance offset (real Whisper timestamp
     * when available) and a 120-char snippet for the preview row.
     */
    private buildDetectedSpeakersFromLabelled(labelled: LabelledTimedTranscript): DetectedSpeaker[] {
        const out: DetectedSpeaker[] = [];
        const seen = new Set<string>();
        const counts = new Map<string, number>();

        // First pass — count occurrences and capture first-utterance offset+text.
        for (const seg of labelled.segments) {
            if (!seg.speaker) continue;
            counts.set(seg.speaker, (counts.get(seg.speaker) ?? 0) + 1);
            if (!seen.has(seg.speaker)) {
                seen.add(seg.speaker);
                out.push({
                    label: seg.speaker,
                    firstUtteranceStartMs:
                        labelled.timestampSource === 'whisper-verbose-json' ? seg.startMs : undefined,
                    firstUtteranceText: seg.text,
                    occurrenceCount: 0, // populated after the loop
                });
            }
        }
        for (const s of out) {
            s.occurrenceCount = counts.get(s.label) ?? 0;
        }
        return out;
    }

    /**
     * Best-effort preview handle for the first audio item. Stays null when no
     * items are attached — the panel handles null gracefully (suppresses
     * preview controls).
     */
    private resolveSpeakerPreviewHandle(): ReturnType<AudioAttachCoordinator['attachPreview']> | null {
        if (!this.audioCoordinator) return null;
        const item = this.state.audioAttachItems[0];
        if (!item) {
            // Fall back to the first auto-detected file if any (so a user who
            // skipped the "Use it" prompt still gets preview).
            const detected = this.state.detectedAudioFiles[0];
            if (!detected?.resolvedFile) return null;
            return this.audioCoordinator.attachPreview({ kind: 'vault', file: detected.resolvedFile });
        }
        return this.audioCoordinator.attachPreview(item.source);
    }

    /** Parse the participants free-text field into an ordered list of names. */
    private parseParticipantsForReview(): string[] {
        return this.state.participants
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            // Strip everything after a colon (e.g. "Sarah Lee: Finance" → "Sarah Lee").
            .map((line) => line.split(':')[0].trim())
            .filter((name) => name.length > 0);
    }

    private handleSpeakerConfirm(mapping: SpeakerMapping): void {
        if (this.state.speakerReview.kind !== 'pending') return;
        this.state.speakerReview = {
            kind: 'confirmed',
            detected: this.state.speakerReview.detected,
            mapping,
        };
        this.renderSpeakerReviewSection();
        // CTA gating uses `canGenerateMinutes(state)` — re-render any visible
        // submit button if the modal has one cached.
        this.refreshSubmitButtonGate();
    }

    private handleSpeakerSkip(reason: 'user-skip' | 'detection-failed' | 'detection-unavailable'): void {
        const detected = this.state.speakerReview.kind === 'pending'
            ? this.state.speakerReview.detected
            : [];
        this.state.speakerReview = { kind: 'skipped', detected, reason };
        this.renderSpeakerReviewSection();
        this.refreshSubmitButtonGate();
    }

    private handleSpeakerEdit(): void {
        if (this.state.speakerReview.kind !== 'confirmed') return;
        this.state.speakerReview = {
            kind: 'pending',
            detected: this.state.speakerReview.detected,
        };
        this.renderSpeakerReviewSection();
        this.refreshSubmitButtonGate();
    }

    /**
     * Toggle the Submit button's disabled state based on the pure
     * canGenerateMinutes derivation. The button itself is created in
     * renderBottomSection; this re-reads its DOM node by class.
     */
    private refreshSubmitButtonGate(): void {
        const btn = this.contentEl.querySelector<HTMLButtonElement>(
            '.ai-organiser-minutes-submit'
        );
        if (!btn) return;
        const canSubmit = canGenerateMinutes({
            transcript: this.state.transcript,
            loadedTranscriptCount: this.transcriptItems.length,
            speakerReview: this.state.speakerReview,
        });
        btn.disabled = !canSubmit;
        if (!canSubmit && this.state.speakerReview.kind === 'pending') {
            setTooltip(btn, this.plugin.t.minutes.confirmSpeakersFirst || 'Confirm speakers first');
        } else {
            setTooltip(btn, '');
        }
    }

    private renderAudioTranscriptionSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        // F1b — Pat persona-test P0 fix (2026-05-23): the section renders
        // UNCONDITIONALLY now. Previously this was gated behind
        // `detectedAudioFiles.length === 0` so a user opening Minutes from a
        // note with no embedded audio had no path to attach audio at all.
        // The new AudioAttachHelper (trio: Attach file / Pick from vault /
        // Record) lives at the top of the section; existing per-item rendering
        // continues below for any auto-detected or user-attached files.
        this.audioSectionEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-audio-section' });

        // Render the attach trio first — entry path for any user.
        const helperContainer = this.audioSectionEl.createDiv({
            cls: 'ai-organiser-minutes-audio-attach-container'
        });
        this.renderAudioAttachHelper(helperContainer);

        // If no items exist (neither auto-detected nor user-attached), stop
        // here — the helper alone gives the user what they need.
        if (this.state.detectedAudioFiles.length === 0) {
            return;
        }


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

            // Per-section assignment dropdown (D11 — only when topics exist).
            if (this.sectionRegistry.hasTopics()) {
                const key = this.audioKey(audioItem);
                const selectHost = itemEl.createDiv({ cls: 'ai-organiser-minutes-audio-section-select' });
                renderSectionAssignmentSelect({
                    host: selectHost,
                    sectionRegistry: this.sectionRegistry,
                    currentSectionId: this.audioSectionAssignments.get(key) || 'general',
                    ariaLabel: `Section assignment for ${audioItem.displayName}`,
                    labels: this.sectionAssignmentLabels(),
                    onChange: (sectionId) => {
                        this.audioSectionAssignments.set(key, sectionId);
                    },
                    onTopicCreated: () => this.rerenderModal(),
                    cleanups: this.cleanups,
                });
            }
        }

        // Dedicated progress panel rendered inline below the audio list — prominent
        // position so a persona watching the modal can actually see the transcription
        // phase updates (was previously only reflected in button textContent via a
        // broken `.minutes-transcribe-btn` selector that never matched — Pat persona
        // round 2 waited 100+s with no visible progress).
        this.audioSectionEl.createDiv({ cls: 'ai-organiser-minutes-audio-progress' });

        this.updateAudioSectionUI();
    }

    private updateAudioSectionUI(): void {
        if (!this.audioSectionEl) return;

        // Correct selector: .ai-organiser-minutes-transcribe-btn (not the legacy
        // unprefixed .minutes-transcribe-btn). Buttons disable during transcription
        // to prevent concurrent clicks.
        const buttons = this.audioSectionEl.querySelectorAll('.ai-organiser-minutes-transcribe-btn');
        buttons.forEach(btn => {
            (btn as HTMLButtonElement).disabled = this.state.isTranscribing;
            if (this.state.isTranscribing) {
                btn.textContent = this.plugin.t.minutes?.transcribing || 'Transcribing…';
            } else {
                btn.textContent = this.plugin.t.minutes?.transcribeButton || 'Transcribe';
            }
        });

        // Update the dedicated progress panel with live phase text.
        const progressEl = this.audioSectionEl.querySelector('.ai-organiser-minutes-audio-progress');
        if (progressEl) {
            if (this.state.isTranscribing) {
                const msg = this.state.transcriptionProgress || this.plugin.t.minutes?.transcribing || 'Transcribing…';
                progressEl.textContent = `⏳ ${msg}`;
                progressEl.setAttribute('data-active', 'true');
            } else {
                progressEl.textContent = '';
                progressEl.removeAttribute('data-active');
            }
        }
    }

    private async handleTranscribeAudio(audioItem: DetectedContent): Promise<void> {
        if (!audioItem.resolvedFile) {
            new Notice(this.plugin.t.minutes?.errorAudioNotFound || 'Audio file not found');
            return;
        }

        // Branch: diarized (Deepgram) vs default Whisper. The diarized path
        // bypasses Whisper + labelSpeakersTimed and uses Deepgram's per-utterance
        // labels directly. Multi-file constraint is enforced at the coordinator
        // (see canTranscribeNow()) but we re-check here for safety.
        if (this.audioCoordinator?.shouldUseDiarization()) {
            const gate = this.audioCoordinator.canTranscribeNow();
            if (!gate.allowed && gate.reason === 'multi-file-diarization') {
                new Notice(this.plugin.t.diarization.multiFileDisabledTooltip, 6000);
                return;
            }
            await this.handleTranscribeAudioDiarized(audioItem);
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
                    azureEndpoint: provider.azureEndpoint,
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

            // Update state and UI — per-section routing: when this audio is
            // assigned to a topic, push as a TranscriptItem instead of
            // overwriting the general textarea, so multi-segment generation
            // sees the breakout transcript distinct from the main meeting.
            const audioSectionId = this.audioSectionAssignments.get(this.audioKey(audioItem)) || 'general';
            if (audioSectionId === 'general' || !this.sectionRegistry.hasTopics()) {
                this.state.transcript = transcript;
                if (this.transcriptTextArea) {
                    this.transcriptTextArea.value = transcript;
                }
            } else {
                this.transcriptItems.push({
                    id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    sourceType: 'transcribed-audio',
                    filePath: audioItem.resolvedFile?.path,
                    displayName: audioItem.displayName,
                    content: transcript,
                    sectionId: audioSectionId,
                    orderIndex: this.transcriptItems.length,
                });
                new Notice(`Transcript added to "${this.sectionRegistry.resolveSection(audioSectionId).name}" section`, 3000);
            }

            // F2c — run the speaker-labelling pre-pass against the verbose_json
            // segments (real Whisper timestamps preserved). Transitions
            // speakerReview into 'pending' (or 'skipped'/'failed' on degraded
            // paths) and re-renders the panel. Awaited so users see the panel
            // before they reach for Generate Minutes.
            // Whisper's detected language wins (most accurate); fall back to
            // the user's transcription-language setting, then 'und' if neither
            // is present. Drives F5 attribution-strategy dispatch.
            const timed = transcriptionResultToTimedTranscript(
                result,
                result.language || this.getTranscriptionLanguageCode() || 'und'
            );
            await this.runSpeakerLabelling(timed);
            this.refreshSubmitButtonGate();

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
     * Diarized transcription path (Deepgram). Skips Whisper + LLM speaker
     * labelling — Deepgram's per-utterance speaker IDs land directly in
     * `state.labelledTranscript` and the speaker review panel renders from there.
     */
    private async handleTranscribeAudioDiarized(audioItem: DetectedContent): Promise<void> {
        if (!audioItem.resolvedFile || !this.audioCoordinator) return;
        if (!this.deepgramKey) {
            new Notice(this.plugin.t.diarization.failedNotice.replace('{error}', 'no-api-key'), 6000);
            return;
        }

        this.state.isTranscribing = true;
        this.state.transcriptionProgress = this.plugin.t.minutes?.transcribing || 'Transcribing…';
        this.updateAudioSectionUI();

        const item: AudioAttachItem = {
            source: { kind: 'vault', file: audioItem.resolvedFile },
            displayName: audioItem.displayName,
            itemState: 'pending',
        };

        try {
            const result = await this.audioCoordinator.transcribeDiarized(item, this.deepgramKey);
            if (!result.ok) {
                const msg = this.plugin.t.diarization.failedNotice.replace('{error}', result.error);
                new Notice(msg, 6000);
                return;
            }
            this.lastDiarizationResult = result.value;
            this.state.transcript = result.value.transcriptText;
            if (this.transcriptTextArea) {
                this.transcriptTextArea.value = result.value.transcriptText;
            }
            this.state.labelledTranscript = result.value.labelled;

            // Build DetectedSpeaker[] from the labelled transcript (same path as Whisper flow)
            const detected = this.buildDetectedSpeakersFromLabelled(result.value.labelled);
            this.state.speakerReview = detected.length < 2
                ? { kind: 'not-required' }
                : { kind: 'pending', detected };
            this.renderSpeakerReviewSection();
            this.refreshSubmitButtonGate();

            // Save transcript to disk (same path as Whisper)
            const savedPath = await this.saveTranscriptToDisk(
                result.value.transcriptText,
                audioItem.resolvedFile,
            );
            if (savedPath) this.state.savedTranscriptPath = savedPath;

            new Notice(this.plugin.t.minutes?.transcriptionComplete || 'Transcription complete');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
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
            const outputFolder = this.getOutputFolder();
            const meetingFolder = `${outputFolder}/${datePart} ${safeTitle}`;

            // Build content with frontmatter linking to audio source for cache lookup.
            // When the diarized path was used, also stamp provider/cost/language
            // into the transcript-note frontmatter (plan §7 transcriptNoteService).
            let content = transcript;
            if (audioFile) {
                const fmLines = [
                    `audio_source: "[[${audioFile.path}]]"`,
                    `transcribed_at: "${new Date().toISOString()}"`,
                ];
                const dia = this.lastDiarizationResult;
                if (dia) {
                    fmLines.push(`diarization_provider: ${dia.provider}`);
                    if (dia.actualCostUsd !== null) {
                        fmLines.push(`diarization_cost_usd: ${dia.actualCostUsd}`);
                    }
                    fmLines.push(`diarization_language: ${dia.detectedLanguage}`);
                }
                content = `---\n${fmLines.join('\n')}\n---\n\n${transcript}`;
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

    private async getTranscriptionProvider(): Promise<{ provider: TranscriptionProvider; apiKey: string; azureEndpoint?: string } | null> {
        const result = await getAudioTranscriptionApiKey(this.plugin);
        if (result) {
            return { provider: result.provider, apiKey: result.key, azureEndpoint: result.azureEndpoint };
        }
        return null;
    }

    // ==================== Context Documents ====================

    /**
     * Render a compact "Auto-detected: [N documents] [N audio]" banner above
     * the main form. Chips scroll the matching section into view so users can
     * jump straight to inputs that the modal found for them without scrolling
     * past the whole form. Renders nothing if no inputs were auto-detected.
     */
    private renderAutoDetectedBanner(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;
        const docCount = this.docController.getCount();
        const audioCount = this.state.detectedAudioFiles.length;
        if (docCount === 0 && audioCount === 0) return;

        const banner = containerEl.createDiv({ cls: 'ai-organiser-minutes-autodetect-banner' });
        banner.createSpan({
            cls: 'ai-organiser-minutes-autodetect-label',
            text: t?.detectedInputsLabel || 'Auto-detected:'
        });

        const scrollTo = (el: HTMLElement | null): void => {
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        if (docCount > 0) {
            const chip = banner.createEl('button', {
                cls: 'ai-organiser-minutes-autodetect-chip',
                text: (t?.detectedDocumentsChip || '{count} document{s}')
                    .replace('{count}', String(docCount))
                    .replace('{s}', docCount === 1 ? '' : 's')
            });
            const iconEl = chip.createSpan({ cls: 'ai-organiser-minutes-autodetect-chip-icon' });
            setIcon(iconEl, 'file-text');
            chip.prepend(iconEl);
            this.cleanups.push(listen(chip, 'click', () => scrollTo(this.documentsSectionEl)));
        }

        if (audioCount > 0) {
            const chip = banner.createEl('button', {
                cls: 'ai-organiser-minutes-autodetect-chip',
                text: (t?.detectedAudioChip || '{count} audio file{s}')
                    .replace('{count}', String(audioCount))
                    .replace('{s}', audioCount === 1 ? '' : 's')
            });
            const iconEl = chip.createSpan({ cls: 'ai-organiser-minutes-autodetect-chip-icon' });
            setIcon(iconEl, 'mic');
            chip.prepend(iconEl);
            this.cleanups.push(listen(chip, 'click', () => scrollTo(this.audioSectionEl)));
        }
    }

    // ============================================================================
    // F4 — Opt-in chip prompt for auto-detected documents
    // ============================================================================

    /**
     * Render the "Detected N documents in this note — [Attach all] [Pick which…]
     * [Ignore]" chip. Only shown when:
     *   1. We previewed ≥1 detected doc from the active note,
     *   2. None of those docs are already in the controller (user hasn't
     *      attached them yet via this prompt OR via the Add Document button), and
     *   3. The user hasn't dismissed the prompt this session.
     *
     * This replaces the v0 silent `autoExtractDetectedDocuments()` flow.
     */
    private renderDetectedDocumentsPrompt(): void {
        if (!this.documentsSectionEl) return;
        const preview = this.state.detectedDocumentsPreview;
        if (preview.length === 0) return;
        if (this.state.detectedDocumentsDismissed) return;

        // If the user has already attached at least one of the detected docs
        // (via Attach all, Pick which…, or Add Document), the chip is stale.
        const attachedIds = new Set(this.docController.getDocuments().map((d) => d.id));
        const stillPending = preview.filter((d) => !attachedIds.has(d.id));
        if (stillPending.length === 0) return;

        const t = this.plugin.t.minutes;
        const chip = this.documentsSectionEl.createDiv({
            cls: 'ai-organiser-minutes-detected-docs-chip',
            attr: { 'data-testid': 'detected-docs-chip' },
        });

        const iconEl = chip.createSpan({ cls: 'ai-organiser-minutes-detected-docs-icon' });
        setIcon(iconEl, 'sparkles');

        const text = stillPending.length === 1
            ? t.docDetectedPromptOne || 'Detected 1 document in this note'
            : (t.docDetectedPromptMany || 'Detected {count} documents in this note').replace(
                  '{count}',
                  String(stillPending.length)
              );
        chip.createSpan({ cls: 'ai-organiser-minutes-detected-docs-text', text });

        // Attach all
        const attachAllBtn = chip.createEl('button', {
            cls: 'ai-organiser-minutes-detected-docs-attach mod-cta',
            text: t.docAttachAll || 'Attach all',
            attr: { 'data-testid': 'detected-docs-attach-all' },
        });
        this.cleanups.push(listen(attachAllBtn, 'click', () => void this.handleAttachAllDetectedDocs()));

        // Pick which…
        const pickBtn = chip.createEl('button', {
            cls: 'ai-organiser-minutes-detected-docs-pick',
            text: t.docPickWhich || 'Pick which…',
            attr: { 'data-testid': 'detected-docs-pick' },
        });
        this.cleanups.push(listen(pickBtn, 'click', () => this.handlePickDetectedDocs()));

        // Ignore
        const ignoreBtn = chip.createEl('button', {
            cls: 'ai-organiser-minutes-detected-docs-ignore',
            text: t.docIgnore || 'Ignore',
            attr: { 'data-testid': 'detected-docs-ignore' },
        });
        this.cleanups.push(listen(ignoreBtn, 'click', () => this.handleIgnoreDetectedDocs()));
    }

    private async handleAttachAllDetectedDocs(): Promise<void> {
        const attached = this.attachDocsFromPreview(this.state.detectedDocumentsPreview);
        // Kick off extraction in the background — user consented to attach,
        // so reading file contents now is no longer silent injection.
        if (attached > 0) {
            await this.docController.extractAll();
        }
        this.state.detectedDocumentsDismissed = true;
        this.rerenderModal();
    }

    private handlePickDetectedDocs(): void {
        const t = this.plugin.t;
        const sourceFile = this.sourceFileAtOpen ?? undefined;
        new DocumentMultiPickerModal(this.app, {
            items: this.state.detectedDocumentsPreview,
            t,
            app: this.app,
            sourceFile,
            sectionRegistry: this.sectionRegistry,
            onConfirm: (selected) => {
                void (async () => {
                    // Attach docs AND propagate sectionId per item to the controller.
                    const items = selected.map((s) => s.item);
                    const attached = this.attachDocsFromPreview(items);
                    // Apply per-row section assignments
                    for (const { item, sectionId } of selected) {
                        this.docController.setSectionId(item.id, sectionId);
                    }
                    if (attached > 0) {
                        await this.docController.extractAll();
                    }
                    this.state.detectedDocumentsDismissed = true;
                    this.rerenderModal();
                })();
            },
        }).open();
    }

    private handleIgnoreDetectedDocs(): void {
        this.state.detectedDocumentsDismissed = true;
        this.rerenderModal();
    }

    /**
     * Attach a batch of preview items into the controller. Returns the count
     * actually added (excludes duplicates already in the controller's list).
     */
    private attachDocsFromPreview(items: DocumentItem[]): number {
        const results = this.docController.addDocuments(items);
        return results.filter((r) => r.added).length;
    }

    /**
     * Build `SegmentInput[]` from modal state for the multi-segment service.
     * Order: General first, then topics in registry order. Each segment's
     * `contextDocuments` is concatenated from docs whose `sectionId` matches.
     * General's transcript is the pasted textarea; topic transcripts are
     * empty in this MVP slice (deferred to follow-up — per-section transcript
     * picker).
     */
    private buildSegmentsFromState(): SegmentInput[] {
        const docs = this.docController.getDocuments();
        const buildContext = (sectionId: string): string =>
            docs
                .filter((d) => (d.sectionId || 'general') === sectionId && d.extractedText && d.truncationChoice !== 'skip')
                .map((d) => `### ${d.name}\n\n${d.extractedText}`)
                .join('\n\n---\n\n');

        const segments: SegmentInput[] = [];
        segments.push({
            sectionId: 'general',
            sectionName: 'General discussion',
            transcript: this.buildEffectiveTranscript('general'),
            contextDocuments: buildContext('general'),
        });
        for (const topic of this.sectionRegistry.listTopics()) {
            segments.push({
                sectionId: topic.id,
                sectionName: topic.name,
                transcript: this.buildEffectiveTranscript(topic.id),
                contextDocuments: buildContext(topic.id),
            });
        }
        return segments;
    }

    /**
     * Resolve the output folder for this minutes session. Returns the user's
     * pick verbatim when set (vault-absolute path from FolderScopePickerModal),
     * or the configured default from settings. NEVER re-routes through
     * `resolveOutputPath`, which would prepend the plugin's output root and
     * silently divert files away from the folder the user explicitly chose
     * (user report 2026-05-29: picked folder ignored, files landed in default).
     */
    private getOutputFolder(): string {
        const picked = (this.state.outputFolder || '').trim();
        const resolved = picked || getMinutesOutputFullPath(this.plugin.settings);
        return normalizePath(resolved);
    }

    /**
     * Build the effective transcript for a section by joining the paste
     * textarea (general only) with any file-loaded transcript items
     * assigned to that section. Used by both the legacy single-segment path
     * (general only) and the multi-segment path (per section). Items are
     * ordered by `orderIndex` so multi-file loads stay deterministic.
     *
     * The paste textarea is only included for the 'general' section because
     * topic sections receive their content exclusively from picker-loaded
     * files (the textarea is treated as a single "general" source).
     */
    private buildEffectiveTranscript(sectionId: string): string {
        const items = this.transcriptItems
            .filter((t) => t.sectionId === sectionId)
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .map((t) => t.content);
        if (sectionId === 'general' && this.state.transcript.trim()) {
            items.unshift(this.state.transcript);
        }
        return items.join('\n\n---\n\n');
    }

    /**
     * D2 — Prompt-and-create a new topic via the always-visible header button.
     * Lightweight inline overlay (matches the picker's `+ New topic…` flow).
     */
    private openAddTopicPrompt(): void {
        const t = this.plugin.t.minutes?.sections;
        const headerEl = this.contentEl.querySelector<HTMLElement>('.ai-organiser-minutes-title-row');
        if (!headerEl) return;
        // Strip any existing prompt before opening a new one.
        headerEl.querySelector('.ai-organiser-minutes-topic-prompt-overlay')?.remove();

        const overlay = headerEl.createDiv({ cls: 'ai-organiser-minutes-topic-prompt-overlay' });
        overlay.setAttribute('role', 'dialog');
        const input = overlay.createEl('input', {
            attr: {
                type: 'text',
                placeholder: t?.topicNamePlaceholder || 'Topic name',
                maxLength: String(SectionRegistryController.MAX_NAME_LENGTH),
                'data-testid': 'modal-topic-name-input',
            },
        });
        const btnRow = overlay.createDiv({ cls: 'ai-organiser-minutes-topic-prompt-buttons' });
        const okBtn = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        const errorEl = overlay.createDiv({
            cls: 'ai-organiser-minutes-topic-prompt-error ai-organiser-hidden',
        });

        const cleanup = (): void => overlay.remove();
        const commit = (): void => {
            const result = this.sectionRegistry.addTopic(input.value);
            if (!result.ok) {
                errorEl.setText(result.error);
                errorEl.removeClass('ai-organiser-hidden');
                return;
            }
            cleanup();
            new Notice((t?.topicCreated || 'Created topic: {name}').replace('{name}', result.value.name));
            this.rerenderModal();
        };
        okBtn.addEventListener('click', commit);
        cancelBtn.addEventListener('click', cleanup);
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') { evt.preventDefault(); commit(); }
            else if (evt.key === 'Escape') { evt.preventDefault(); cleanup(); }
        });
        input.focus();
    }

    /**
     * Render topic chips next to the modal title summarising the active topics.
     * Pure presentational; updated on rerender.
     */
    private renderTopicChips(containerEl: HTMLElement): void {
        const chipsEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-topic-chips' });
        for (const topic of this.sectionRegistry.listTopics()) {
            const chip = chipsEl.createDiv({
                cls: 'ai-organiser-minutes-topic-chip',
                attr: { 'data-topic-id': topic.id, 'data-testid': 'minutes-topic-chip' },
            });
            chip.setText(SectionRegistryController.displayLabel(topic.name));
        }
    }

    private renderContextDocumentsSection(containerEl: HTMLElement): void {
        const t = this.plugin.t.minutes;

        this.documentsSectionEl = containerEl.createDiv({ cls: 'ai-organiser-minutes-documents-section' });

        const header = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-minutes-section-icon' });
        setIcon(iconEl, 'file-text');
        header.createSpan({ text: t?.contextDocumentsSection || 'Context Documents' });

        const desc = this.documentsSectionEl.createDiv({ cls: 'ai-organiser-minutes-section-desc' });
        desc.setText(t?.contextDocumentsDesc || 'Attach agendas, presentations, or spreadsheets to improve accuracy');

        // F4 — Opt-in chip prompt for documents detected in the active note.
        // Replaces the v0 silent auto-extract (Pat persona P1).
        this.renderDetectedDocumentsPrompt();

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

            // D11 — main-modal attached-row dropdown only rendered when topics exist.
            if (this.sectionRegistry.hasTopics()) {
                const selectHost = itemEl.createDiv({ cls: 'ai-organiser-minutes-document-section-select' });
                renderSectionAssignmentSelect({
                    host: selectHost,
                    sectionRegistry: this.sectionRegistry,
                    currentSectionId: doc.sectionId || 'general',
                    ariaLabel: `Section assignment for ${doc.name}`,
                    labels: this.sectionAssignmentLabels(),
                    onChange: (sectionId) => {
                        this.docController.setSectionId(doc.id, sectionId);
                    },
                    onTopicCreated: () => this.rerenderModal(),
                    cleanups: this.cleanups,
                });
            }
        }
    }

    /** Stable key for per-audio section assignment lookup. */
    private audioKey(audioItem: DetectedContent): string {
        return audioItem.resolvedFile?.path || audioItem.displayName;
    }

    /**
     * Open the transcript multi-picker. Uses DocumentMultiPickerModal with
     * the scoped file picker header ("Files in this note" first, "All vault
     * files" toggle for the rest). Selected files are extracted via the
     * document service and added to `transcriptItems[]`. When topics exist,
     * each file can be assigned to a specific section; otherwise everything
     * defaults to 'general' and joins the pasted-text segment.
     */
    private openTranscriptMultiPicker(): void {
        const allowedExtensions = new Set<string>(['md', ...ALL_DOCUMENT_EXTENSIONS]);
        const roleFilter = (f: TFile): boolean => allowedExtensions.has(f.extension.toLowerCase());
        // In-note files first, full vault still searchable. The picker's
        // ScopedFilePickerHeader gives the user an explicit toggle too.
        const all = this.app.vault.getFiles()
            .filter(roleFilter)
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
        const inNote = getScopedFiles(this.app, this.sourceFileAtOpen, 'active-note', roleFilter);
        const inNotePaths = inNote.scope === 'active-note' ? new Set(inNote.files.map((f) => f.path)) : new Set<string>();
        const preferred = all.filter((f) => inNotePaths.has(f.path));
        const rest = all.filter((f) => !inNotePaths.has(f.path));
        const candidates = [...preferred, ...rest];
        if (candidates.length === 0) {
            new Notice('No transcript files found in this note', 3000);
            return;
        }
        const items: DocumentItem[] = candidates.map((f) => ({
            id: f.path,
            name: f.name,
            path: f.path,
            isExternal: false,
            file: f,
            truncationChoice: 'full' as const,
            charCount: 0,
            isProcessing: false,
            sectionId: 'general',
        }));
        new DocumentMultiPickerModal(this.app, {
            items,
            t: this.plugin.t,
            app: this.app,
            sourceFile: this.sourceFileAtOpen || undefined,
            sectionRegistry: this.sectionRegistry,
            onConfirm: (selected) => {
                void (async () => {
                    let added = 0;
                    for (const { item, sectionId } of selected) {
                        if (!item.file) continue;
                        let content: string;
                        if (item.file.extension.toLowerCase() === 'md') {
                            content = await this.app.vault.read(item.file);
                            const fmMatch = content.match(/^---\n[\s\S]*?\n---\n\n?/);
                            if (fmMatch) content = content.slice(fmMatch[0].length);
                        } else {
                            const result = await this.documentService.extractText(item.file);
                            if (!result.success || !result.text) {
                                new Notice(`Skipped ${item.name}: ${result.error || 'extraction failed'}`);
                                continue;
                            }
                            content = result.text;
                        }
                        this.transcriptItems.push({
                            id: `tx-${Date.now()}-${added}`,
                            sourceType: 'vault-file',
                            filePath: item.file.path,
                            displayName: item.name,
                            content,
                            sectionId,
                            orderIndex: this.transcriptItems.length,
                        });
                        added++;
                    }
                    if (added > 0) {
                        new Notice(`Loaded ${added} transcript${added === 1 ? '' : 's'} into topic sections`, 3000);
                        this.rerenderModal();
                    }
                })();
            },
        }).open();
    }

    /** Shared i18n labels for SectionAssignmentSelect. */
    private sectionAssignmentLabels(): {
        generalOption: string; newTopicOption: string; topicNamePrompt: string;
        topicNameTooLong: string; topicCreated: string; topicPrefix: string;
    } {
        const t = this.plugin.t.minutes?.sections;
        return {
            generalOption: t?.general || 'General',
            newTopicOption: '+ ' + (t?.addTopicButton || 'New topic…'),
            topicNamePrompt: t?.topicNamePlaceholder || 'Topic name',
            topicNameTooLong: t?.topicNameTooLong || `Topic name must be ${SectionRegistryController.MAX_NAME_LENGTH} characters or fewer`,
            topicCreated: t?.topicCreated || 'Created topic',
            topicPrefix: 'Topic: ',
        };
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
            const roleFilter = (f: TFile): boolean => {
                const ext = f.extension.toLowerCase();
                return ALL_DOCUMENT_EXTENSIONS.includes(ext as typeof ALL_DOCUMENT_EXTENSIONS[number]);
            };
            const items = this.buildVaultPickerItems(roleFilter);
            if (items.length === 0) {
                new Notice(this.plugin.t.minutes?.noDocumentsFound || 'No documents found in vault');
                return;
            }
            new DocumentMultiPickerModal(this.app, {
                items,
                t: this.plugin.t,
                app: this.app,
                sourceFile: this.sourceFileAtOpen || undefined,
                sectionRegistry: this.sectionRegistry,
                title: 'Add documents',
                description: 'Files in this note are shown first; switch to "All vault files" to browse the rest.',
                confirmLabel: 'Attach selected',
                onConfirm: (selected) => {
                    let attached = 0;
                    for (const { item, sectionId } of selected) {
                        if (!item.file) continue;
                        try {
                            const result = this.docController.addFromVault(item.file);
                            if (!result.added) {
                                new Notice(result.error || `Failed to add ${item.name}`);
                                continue;
                            }
                            this.docController.setSectionId(item.id, sectionId);
                            attached++;
                        } catch (err) {
                            logger.error('Minutes', 'Document attach failed:', err);
                            new Notice(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                    if (attached > 0) {
                        new Notice(`Attached ${attached} document${attached === 1 ? '' : 's'}`);
                        this.refreshDocumentsSection();
                    }
                },
            }).open();
        } catch (error) {
            logger.error('Minutes', 'Failed to open document picker:', error);
            new Notice('Failed to open document picker');
        }
    }

    /**
     * Build DocumentItem[] from vault files matching roleFilter. Used by every
     * scoped vault picker (Add Document, agenda, style reference) so the
     * DocumentMultiPickerModal's ScopedFilePickerHeader can render the
     * "Files in this note (N) · All vault files (M)" radio toggle. Sorts
     * by most-recent-modified so the freshest files surface first within
     * each scope.
     */
    private buildVaultPickerItems(roleFilter: (f: TFile) => boolean): DocumentItem[] {
        const all = this.app.vault.getFiles()
            .filter(roleFilter)
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
        return all.map((f) => ({
            id: f.path,
            name: f.name,
            path: f.path,
            isExternal: false,
            file: f,
            truncationChoice: 'full' as const,
            charCount: 0,
            isProcessing: false,
            sectionId: 'general',
        }));
    }

    /**
     * Opens a vault file picker for style reference documents.
     * Accepts markdown, Office documents (docx, xlsx, pptx, txt, rtf), and PDFs.
     * Returns the selected TFile or null if cancelled.
     *
     * Routes through DocumentMultiPickerModal in single-select mode so users
     * get the "Files in this note (N) · All vault files (M)" radio toggle
     * instead of a flat fuzzy list mixed across the entire vault.
     */
    private pickStyleReferenceFile(opts?: { title?: string; description?: string; confirmLabel?: string }): Promise<TFile | null> {
        const allowedExtensions = new Set(['md', ...ALL_DOCUMENT_EXTENSIONS]);
        const roleFilter = (f: TFile): boolean => allowedExtensions.has(f.extension.toLowerCase());
        const items = this.buildVaultPickerItems(roleFilter);
        if (items.length === 0) {
            new Notice(this.plugin.t.messages?.noMdFiles || 'No files found');
            return Promise.resolve(null);
        }
        return new Promise<TFile | null>((resolve) => {
            let settled = false;
            const settle = (v: TFile | null): void => {
                if (settled) return;
                settled = true;
                resolve(v);
            };
            const picker = new DocumentMultiPickerModal(this.app, {
                items,
                t: this.plugin.t,
                app: this.app,
                sourceFile: this.sourceFileAtOpen || undefined,
                singleSelect: true,
                title: opts?.title || 'Pick a file from the vault',
                description: opts?.description
                    || 'Files in this note are shown first; switch to "All vault files" to browse the rest.',
                confirmLabel: opts?.confirmLabel || 'Use this file',
                onConfirm: (selected) => {
                    const file = selected[0]?.item.file ?? null;
                    settle(file);
                },
            });
            const origClose = picker.onClose.bind(picker);
            picker.onClose = (): void => {
                origClose();
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

    /**
     * Renders a banner with arbitrary status text (no "File loaded:" prefix).
     * Used for multi-file summaries like "3 transcripts loaded".
     */
    private showStatusBannerText(banner: HTMLElement, text: string): void {
        banner.addClass('ai-organiser-block');
        banner.textContent = `\u2705 ${text}`;
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

        const listEl = this.documentsSectionEl.querySelector('.ai-organiser-minutes-document-list');
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

            // Dictionary extraction is a Haiku-level structured-output task —
            // shallow proper-noun / acronym pull with strict JSON output. Route
            // to the provider's fast tier (Haiku for Claude, Flash for Gemini,
            // gpt-mini for OpenAI) when available; fall back to the main model
            // on parse failure ("escalate to Sonnet if things are unclear",
            // per user request 2026-05-29). Local LLM has no fast tier — just
            // uses its configured model.
            const settings = this.plugin.settings;
            const useFastTier = settings.serviceType === 'cloud';
            const mainModel = settings.cloudModel || '';
            const fastModel = useFastTier
                ? resolveSlideTierModel(settings.cloudServiceType, 'fast', mainModel)
                : undefined;
            const baseOpts: SummarizeOptions = {
                disableThinking: true,
                maxTokens: 4096,
                timeoutMs: 120_000,
            };

            const callLLM = async (modelOverride?: string): Promise<{ success: boolean; content?: string; error?: string }> => {
                const opts: SummarizeOptions = modelOverride
                    ? { ...baseOpts, modelOverride }
                    : baseOpts;
                return this.plugin.llmService.summarizeText(fullPrompt, opts);
            };

            // Attempt 1 — fast tier (or main if no fast tier available)
            const firstModelLabel = fastModel && fastModel !== mainModel ? 'fast model' : 'main model';
            logger.debug('Minutes', `Dictionary extraction attempt 1 via ${firstModelLabel}: ${fastModel || mainModel || 'default'}`);
            let response = await withBusyIndicator(this.plugin, () => callLLM(fastModel));
            let parseResult = response.success && response.content
                ? this.dictionaryService.parseExtractionResponse(response.content)
                : { success: false, error: response.error || 'No response from model' } as ReturnType<typeof this.dictionaryService.parseExtractionResponse>;
            logger.debug('Minutes', `Dictionary parse (attempt 1) success=${parseResult.success} entries=${parseResult.entries?.length ?? 0} err=${parseResult.error || ''}`);

            // Attempt 2 — escalate to main model when fast tier failed to
            // produce parseable JSON OR returned an empty array. The user
            // explicitly asked for "Haiku-level but escalate to Sonnet if
            // things are unclear, and certainly should not fail silently."
            const fastFailed = !parseResult.success
                || !parseResult.entries
                || parseResult.entries.length === 0;
            if (fastFailed && fastModel && fastModel !== mainModel) {
                this.state.dictionaryExtractionProgress = (t?.dictionaryExtracting || 'Extracting terms...') + ' (retrying with main model)';
                this.refreshDictionarySection();
                logger.debug('Minutes', `Dictionary extraction attempt 2 escalating to main model: ${mainModel || 'default'}`);
                response = await withBusyIndicator(this.plugin, () => callLLM(undefined));
                parseResult = response.success && response.content
                    ? this.dictionaryService.parseExtractionResponse(response.content)
                    : { success: false, error: response.error || 'No response from model' } as ReturnType<typeof this.dictionaryService.parseExtractionResponse>;
                logger.debug('Minutes', `Dictionary parse (attempt 2) success=${parseResult.success} entries=${parseResult.entries?.length ?? 0} err=${parseResult.error || ''}`);
            }

            if (!parseResult.success || !parseResult.entries) {
                throw new Error(parseResult.error || 'Failed to parse extracted terms');
            }

            if (parseResult.entries.length === 0) {
                new Notice('No terms found in the documents — model returned an empty list. Try with different documents or check the developer console.', 6000);
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
        // F1b/F2c — release any audio-preview object URLs the coordinator
        // created and the SpeakerReviewPanel's DOM listeners. Idempotent;
        // safe to call even if neither was rendered.
        this.modalIsOpen = false;
        this.speakerReviewHandle?.destroy();
        this.speakerReviewHandle = null;
        this.speakerReviewContainerEl = null;
        this.audioAttachHandle?.destroy();
        this.audioAttachHandle = null;
        this.audioCoordinator?.dispose();
        this.audioCoordinator = null;
        // Reset init flag so the next real open re-creates controllers with
        // fresh state. Pairs with the lazy-init guard in onOpen().
        this.controllersInitialized = false;
        // Reset per-section state so the next modal open starts clean.
        this.audioSectionAssignments.clear();
        this.transcriptItems = [];

        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }

    // ============================================================================
    // Diarization opt-in (plan §1.5 + Gemini G3)
    // ============================================================================

    private async resolveDeepgramKeyAndRefresh(): Promise<void> {
        try {
            this.deepgramKey = await getDeepgramApiKey(this.plugin);
        } catch {
            this.deepgramKey = null;
        }
        if (!this.modalIsOpen) return;
        // Re-render the audio helper so the toggle slot reflects key availability
        const helperContainer = this.contentEl.querySelector<HTMLElement>(
            '.ai-organiser-minutes-audio-attach-container',
        );
        if (helperContainer) this.renderAudioAttachHelper(helperContainer);
    }

    /**
     * Build the diarizationToggle options for the helper. Returns undefined
     * (no checkbox) on mobile, when provider !== 'deepgram', or when the key
     * is not yet configured / resolved.
     */
    private buildDiarizationToggleOptions() {
        if (Platform.isMobile) return undefined;
        if (this.plugin.settings.audioDiarisationProvider !== 'deepgram') return undefined;
        if (!this.deepgramKey) return undefined;
        if (!this.audioCoordinator) return undefined;

        const checked = this.audioCoordinator.shouldUseDiarization();
        const costPreviewText = this.computeDiarizationCostPreviewText();

        return {
            visible: true,
            checked,
            disabled: !!this.state.isTranscribing,
            costPreviewText,
            onChange: (next: boolean) => this.handleDiarizationToggleChange(next),
        };
    }

    private computeDiarizationCostPreviewText(): string | null {
        if (!this.audioCoordinator) return null;
        // Use the first detected/attached audio item's size as the basis for the
        // cost preview. If no items yet, we still show the per-minute rate cue
        // by returning the costUnknown line so users see something.
        const tDia = this.plugin.t.diarization;
        const firstAudio = this.state.detectedAudioFiles?.[0]?.resolvedFile;
        if (!firstAudio) return tDia.costUnknown;
        const upfront = this.audioCoordinator.getUpfrontSourceSize({
            kind: 'vault',
            file: firstAudio,
        });
        if (upfront === null || upfront <= 0) return tDia.costUnknown;
        const usd = this.audioCoordinator.estimateAudioCostUsd(upfront);
        const formatted = this.audioCoordinator.formatCostPreview(usd);
        return tDia.costPreview.replace('{cost}', formatted);
    }

    private handleDiarizationToggleChange(next: boolean): void {
        if (!this.audioCoordinator) return;

        if (next && !this.plugin.diarizationDisclosureShownThisSession) {
            DiarizationPrivacyModal.openOnce(this.app, this.plugin.t, (accepted) => {
                if (accepted) {
                    this.plugin.diarizationDisclosureShownThisSession = true;
                    this.diarizationOptedIn = true;
                    this.audioCoordinator!.setDiarizationOptIn(true);
                    this.maybeWarnLargeFileSync();
                } else {
                    this.diarizationOptedIn = false;
                    this.audioCoordinator!.setDiarizationOptIn(false);
                }
                this.rerenderAudioHelper();
            });
            return;
        }

        this.diarizationOptedIn = next;
        this.audioCoordinator.setDiarizationOptIn(next);
        if (next) this.maybeWarnLargeFileSync();
        this.rerenderAudioHelper();
    }

    private maybeWarnLargeFileSync(): void {
        if (this.plugin.diarizationLargeFileWarningShownThisSession) return;
        const firstAudio = this.state.detectedAudioFiles?.[0]?.resolvedFile;
        if (!firstAudio) return;
        const size = firstAudio.stat?.size ?? 0;
        if (size < DEEPGRAM_LARGE_FILE_WARN_BYTES) return;
        this.plugin.diarizationLargeFileWarningShownThisSession = true;
        const sizeMB = Math.round(size / (1024 * 1024));
        new Notice(
            this.plugin.t.diarization.largeFileSyncWarning.replace('{sizeMB}', String(sizeMB)),
            8000,
        );
    }

    private rerenderAudioHelper(): void {
        const helperContainer = this.contentEl.querySelector<HTMLElement>(
            '.ai-organiser-minutes-audio-attach-container',
        );
        if (helperContainer) this.renderAudioAttachHelper(helperContainer);
    }
}

