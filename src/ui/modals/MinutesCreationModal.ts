import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { MinutesService } from '../../services/minutesService';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import { MeetingContext, OutputAudience, ConfidentialityLevel } from '../../services/prompts/minutesPrompts';

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
}

export class MinutesCreationModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private minutesService: MinutesService;
    private state: MinutesModalState;
    private transcriptTextArea: HTMLTextAreaElement | null = null;
    private privacyWarningEl: HTMLElement | null = null;

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
            customInstructions: ''
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
            const result = await this.minutesService.generateMinutes({
                metadata,
                participantsRaw: this.state.participants,
                transcript: this.state.transcript,
                personaId: this.state.personaId,
                outputFolder: this.plugin.settings.minutesOutputFolder,
                customInstructions: this.state.customInstructions,
                languageOverride: this.state.languageOverride
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
}
