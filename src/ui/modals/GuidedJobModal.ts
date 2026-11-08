/**
 * A guided job (docs/plans/navigation-discoverability.md, decision 7): collect the input, show
 * what the job needs with a fix on every missing row, then hand off to the existing flow. It
 * records nothing; cancelling leaves nothing behind.
 */
import { App, ButtonComponent, FuzzySuggestModal, Modal, Setting, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { evaluateJob, JOB_BY_ID, type JobDef, type JobPrerequisite, type RowState } from '../../core/jobs';
import { actionName } from '../../core/actionRegistry';

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'webm', 'flac', 'aac', 'mp4']);

export interface GuidedJobDeps {
    rowState: (p: JobPrerequisite) => RowState;
    /** Open activation for an off feature's action (resumes this job after the reload). */
    turnOn: (actionId: string) => void;
    /** Run a setup or other action as from the palette. */
    run: (actionId: string) => void;
    /** Open the plugin settings (the fix for a setup row with no specific setup action). */
    openSettings: () => void;
    /** Hand off to the job's own flow. */
    start: (job: JobDef, input: TFile | null) => void;
}

class AudioFileSuggest extends FuzzySuggestModal<TFile> {
    constructor(app: App, private readonly files: TFile[], private readonly onPick: (f: TFile) => void) { super(app); }
    getItems(): TFile[] { return this.files; }
    getItemText(f: TFile): string { return f.path; }
    onChooseItem(f: TFile): void { this.onPick(f); }
}

export class GuidedJobModal extends Modal {
    private input: TFile | null = null;
    private readonly job: JobDef | undefined;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, jobId: string, private readonly deps: GuidedJobDeps) {
        super(app);
        this.job = JOB_BY_ID.get(jobId);
    }

    onOpen(): void { this.render(); }

    private render(): void {
        const job = this.job;
        if (!job) { this.close(); return; }
        const t = this.plugin.t.jobs;
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText(t[job.id].title);
        contentEl.createEl('p', { text: t[job.id].desc });

        if (job.input === 'audio-file') {
            contentEl.createEl('h4', { text: t.inputHeading });
            const audio = this.app.vault.getFiles().filter((f) => AUDIO_EXTENSIONS.has(f.extension.toLowerCase()));
            new Setting(contentEl)
                .setName(this.input ? t.chosenAudio.replace('{name}', this.input.name) : t.chooseAudio)
                .setDesc(audio.length === 0 ? t.noAudio : '')
                .addButton((b) => b.setButtonText(t.chooseAudio).setDisabled(audio.length === 0).onClick(() => {
                    new AudioFileSuggest(this.app, audio, (f) => { this.input = f; this.render(); }).open();
                }));
            new Setting(contentEl)
                .setName(t.recordFirst)
                .setDesc(t.recordFirstDesc)
                .addButton((b) => b.setButtonText(t.recordFirst).onClick(() => { this.close(); this.deps.run('record-audio'); }));
        }

        const result = evaluateJob(job, this.deps.rowState, this.input !== null);
        contentEl.createEl('h4', { text: t.checklistHeading });
        for (const row of result.rows) this.renderRow(row.prerequisite, row.state, row.optional);

        // Say what Continue does before the person presses it.
        contentEl.createEl('p', { text: t[job.id].next, cls: 'setting-item-description' });
        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttons).setButtonText(t.cancel).onClick(() => this.close());
        const go = new ButtonComponent(buttons).setButtonText(t.continue).setCta().setDisabled(!result.canStart);
        go.onClick(() => {
            if (!evaluateJob(job, this.deps.rowState, this.input !== null).canStart) return;
            this.close();
            this.deps.start(job, this.input);
        });
        // Enter should do the thing the window is for, not cancel it.
        if (result.canStart) window.setTimeout(() => go.buttonEl.focus(), 0);
    }

    private renderRow(p: JobPrerequisite, state: RowState, optional: boolean): void {
        const t = this.plugin.t.jobs;
        const name = p.kind === 'inbox-folders' ? t.inboxFolders : actionName(this.plugin.t, p.actionId);
        const status = { ready: t.rowReady, 'feature-off': t.rowOff, 'needs-setup': t.rowSetup, unavailable: t.rowUnavailable }[state];
        const setting = new Setting(this.contentEl)
            .setName(optional ? `${name} (${t.optional})` : name)
            .setDesc(status);
        setting.settingEl.addClass(state === 'ready' ? 'ai-organiser-job-row-ready' : 'ai-organiser-job-row-missing');
        if (state === 'feature-off' && p.kind === 'action') {
            setting.addButton((b) => b.setButtonText(t.turnOn).onClick(() => { this.close(); this.deps.turnOn(p.actionId); }));
        } else if (state === 'needs-setup') {
            const fix = p.fixActionId;
            setting.addButton((b) => b.setButtonText(t.setUp).onClick(() => {
                this.close();
                if (fix) this.deps.run(fix);
                else this.deps.openSettings();
            }));
        }
    }

    onClose(): void { this.contentEl.empty(); }
}
