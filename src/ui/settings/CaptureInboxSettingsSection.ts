import { Notice, Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { getCaptureController } from '../../commands/captureInboxCommands';
import { openCaptureInboxSetup } from '../modals/CaptureInboxSetupModal';
import { captureBlocker } from '../../services/captureInbox/captureConfig';
import { emptyCounters, type CaptureCounters } from '../../services/captureInbox/captureTypes';

const sum = (record: Record<string, number>): number => Object.values(record).reduce((a, b) => a + b, 0);

/** The activity line and the text that "Copy summary" copies: counts only, nothing about content. */
export function activitySummary(counters: CaptureCounters, line: string): string {
    return line
        .replace('{processed}', String(counters.processed))
        .replace('{accepted}', String(counters.acceptedUnchanged + counters.acceptedEdited))
        .replace('{rejected}', String(counters.rejected))
        .replace('{failed}', String(sum(counters.failed)));
}

/**
 * Capture inbox settings: a status row, a plain summary, the buttons, one collapsed Advanced group and the
 * local activity counters. Folder and rule editing happens in the guided setup (shared with the inbox sweep).
 */
export class CaptureInboxSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.captureInbox;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'inbox', 2);

        const folders = this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path);
        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: c.statusName,
            evaluation: evaluateSetup('capture-inbox', s, { existingFolders: toFolderSet(folders) }),
            onOpen: () => openCaptureInboxSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });
        const blocker = captureBlocker(s, !!this.plugin.llmService);
        if (blocker) this.containerEl.createDiv({ cls: 'setting-item-description', text: formatGuidance(describeError(t, blocker)) });

        const ctl = getCaptureController(this.plugin);
        new Setting(this.containerEl).setClass('ai-organiser-button-row')
            .addButton((b) => b.setButtonText(c.setupButton).setCta().onClick(() => openCaptureInboxSetup(this.plugin, () => this.settingTab.display())))
            .addButton((b) => b.setButtonText(c.runNow).onClick(() => { if (ctl) void ctl.processNow(); else new Notice(c.queueChecking, 3000); }))
            .addButton((b) => b.setButtonText(c.reviewButton).onClick(() => { if (ctl) ctl.openQueue(); else new Notice(c.queueChecking, 3000); }));

        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-advanced-group' });
        details.createEl('summary', { text: c.advancedTitle });
        const num = (name: string, desc: string | null, get: () => number, set: (n: number) => void, min: number, max: number): void => {
            const setting = new Setting(details).setName(name);
            if (desc) setting.setDesc(desc);
            setting.addText((tx) => tx.setValue(String(get())).onChange((v) => {
                const n = Math.floor(Number(v));
                if (Number.isFinite(n) && n >= min && n <= max) { set(n); void this.plugin.saveSettings(); }
            }));
        };
        const toggle = (name: string, desc: string, get: () => boolean, set: (b: boolean) => void): void => {
            new Setting(details).setName(name).setDesc(desc).addToggle((tg) => tg.setValue(get()).onChange((v) => { set(v); void this.plugin.saveSettings(); }));
        };
        toggle(c.onOpenName, c.onOpenDesc, () => s.captureOnOpen, (v) => { s.captureOnOpen = v; });
        num(c.onOpenMaxName, null, () => s.captureOnOpenMaxPerRun, (n) => { s.captureOnOpenMaxPerRun = n; }, 1, 10);
        num(c.maxPerRunName, null, () => s.captureMaxPerRun, (n) => { s.captureMaxPerRun = n; }, 1, 50);
        num(c.maxAttachmentName, c.maxAttachmentDesc, () => s.captureMaxAttachmentMB, (n) => { s.captureMaxAttachmentMB = n; }, 1, 25);
        num(c.minWordsName, c.minWordsDesc, () => s.captureMinWords, (n) => { s.captureMinWords = n; }, 1, 50);
        toggle(c.digitiseImagesName, c.digitiseImagesDesc, () => s.captureDigitiseImages, (v) => { s.captureDigitiseImages = v; });
        num(c.stabilityName, c.stabilityDesc, () => s.captureStabilitySeconds, (n) => { s.captureStabilitySeconds = n; }, 2, 120);
        toggle(c.requireMarkerName, c.requireMarkerDesc, () => s.captureRequireMarker, (v) => { s.captureRequireMarker = v; });

        // Local counters only. Nothing here is sent anywhere; "Copy summary" puts the counts on the clipboard.
        const counters = ctl?.store.get().counters ?? emptyCounters();
        this.containerEl.createEl('h4', { text: c.activityTitle });
        const summary = activitySummary(counters, c.activityLine);
        this.containerEl.createDiv({ cls: 'setting-item-description', text: summary });
        new Setting(this.containerEl).addButton((b) => b.setButtonText(c.copySummary).onClick(() => {
            void navigator.clipboard.writeText(summary).then(() => new Notice(c.copiedNotice, 3000));
        }));
    }
}
