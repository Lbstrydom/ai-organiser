import { FileSystemAdapter, Notice, Platform, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { isInsideOrEqual, isProtectedPath, normalisePath } from '../../core/protectedPaths';
import { checkMountFolderWithin } from '../../services/offload/localMount';
import { nodeDeps } from '../../services/offload/fingerprint';
import { checkDestination, importFolderForInstructions } from '../../services/claudeImport/importGate';
import { importFromClaudeNow } from '../../commands/claudeImportCommands';

const MOUNT_CODES: Record<string, string> = {
    'mount-invalid': 'claude-import-source-invalid',
    'mount-missing': 'claude-import-source-missing',
    'mount-slow': 'claude-import-source-missing',
    'mount-inside-vault': 'claude-import-source-inside-vault',
    'mount-vault-unverified': 'claude-import-source-invalid',
};

/** Import from Claude: the Drive folder to read, the vault folder for copies, what Claude is told, the automatic look and limits. */
export class ClaudeImportSettingsSection extends BaseSettingSection {
    private unsubscribe: (() => void) | null = null;

    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t.claudeImport;
        const s = this.plugin.settings;
        const el = this.containerEl;
        this.createSectionHeader(t.sectionTitle, 'download', 2);
        el.createEl('p', { cls: 'setting-item-description', text: t.settingsIntro });
        el.createEl('p', { cls: 'ai-organiser-claude-import-warning', text: t.trustWarning });
        if (Platform.isMobile || !this.plugin.claudeImport) {
            el.createEl('p', { cls: 'setting-item-description', text: t.mobileOnly });
        }

        let folderResult: HTMLElement | null = null;
        new Setting(el)
            .setName(t.sourceName)
            .setDesc(t.sourceDesc)
            .addText((text) => text
                .setPlaceholder(t.sourcePlaceholder)
                .setValue(s.claudeImportSourceFolder)
                .onChange(async (value) => {
                    s.claudeImportSourceFolder = value.trim();
                    // The computer where the folder is chosen is the one that imports.
                    if (this.plugin.claudeImport && s.claudeImportSourceFolder !== '') await this.plugin.claudeImport.claim();
                    else await this.plugin.saveSettings();
                    told.setText(this.toldText());
                }))
            .addButton((b) => b.setButtonText(t.checkFolder).onClick(async () => {
                const out = folderResult;
                if (!out) return;
                out.empty();
                const deps = nodeDeps();
                const adapter = this.plugin.app.vault.adapter;
                if (!deps || !(adapter instanceof FileSystemAdapter)) { out.setText(formatGuidance(describeError(this.plugin.t, 'claude-import-desktop-only'))); return; }
                if (s.claudeImportSourceFolder === '') { out.setText(formatGuidance(describeError(this.plugin.t, 'claude-import-no-source'))); return; }
                const res = await checkMountFolderWithin(deps, s.claudeImportSourceFolder, adapter.getBasePath());
                out.setText(res.ok ? t.folderOk : formatGuidance(describeError(this.plugin.t, MOUNT_CODES[res.error] ?? 'claude-import-source-invalid')));
            }));
        folderResult = el.createDiv({ cls: 'setting-item-description' });

        let destNote: HTMLElement | null = null;
        const showDest = (): void => {
            if (!destNote) return;
            destNote.empty();
            const checked = checkDestination(s.claudeImportDestination, (p) => isProtectedPath(s, p), this.plugin.app.vault.configDir);
            if (!checked.ok) { destNote.setText(formatGuidance(describeError(this.plugin.t, checked.error))); return; }
            const inInbox = s.sweepInboxFolders.map(normalisePath).filter(Boolean).some((f) => isInsideOrEqual(checked.value, f));
            if (!inInbox) destNote.setText(t.destinationNotInbox);
        };
        new Setting(el)
            .setName(t.destinationName)
            .setDesc(t.destinationDesc)
            .addText((text) => text
                .setValue(s.claudeImportDestination)
                .onChange(async (value) => {
                    s.claudeImportDestination = value.trim();
                    await this.plugin.saveSettings();
                    showDest();
                }));
        destNote = el.createDiv({ cls: 'setting-item-description' });
        showDest();

        const toldSetting = new Setting(el).setName(t.claudeToldName);
        const told = toldSetting.descEl.createDiv({ text: this.toldText() });

        new Setting(el)
            .setName(t.autoName)
            .setDesc(t.autoDesc)
            .addText((text) => text
                .setValue(String(s.claudeImportAutoMinutes))
                .onChange(async (value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    s.claudeImportAutoMinutes = n <= 0 ? 0 : Math.min(240, Math.max(2, Math.round(n)));
                    await this.plugin.saveSettings();
                }));

        this.renderStatus(el);

        el.createEl('h4', { text: t.limitsHeading });
        new Setting(el)
            .setName(t.maxName)
            .setDesc(t.maxDesc)
            .addText((text) => text
                .setValue(String(s.claudeImportMaxKB))
                .onChange(async (value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    s.claudeImportMaxKB = Math.min(4096, Math.max(16, Math.round(n)));
                    await this.plugin.saveSettings();
                }));
        new Setting(el)
            .setName(t.settleName)
            .setDesc(t.settleDesc)
            .addText((text) => text
                .setValue(String(s.claudeImportStabilitySeconds))
                .onChange(async (value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    s.claudeImportStabilitySeconds = Math.min(600, Math.max(5, Math.round(n)));
                    await this.plugin.saveSettings();
                }));
    }

    private toldText(): string {
        const t = this.plugin.t.claudeImport;
        const folder = importFolderForInstructions(this.plugin.settings);
        return folder ? t.claudeToldDesc.replace('{folder}', folder) : t.claudeToldNone;
    }

    private renderStatus(el: HTMLElement): void {
        const runtime = this.plugin.claudeImport;
        if (!runtime) return;
        const t = this.plugin.t.claudeImport;
        const box = el.createDiv();
        const draw = (): void => {
            box.empty();
            const st = runtime.status();
            const status = new Setting(box).setName(t.statusName);
            let line = t.statusNever;
            if (st.running) line = t.statusRunning;
            else if (st.last?.error) line = formatGuidance(describeError(this.plugin.t, st.last.error));
            else if (st.last?.report) {
                const r = st.last.report;
                const parts = [
                    r.imported.length > 0 ? t.summaryImported.replace('{count}', String(r.imported.length)) : '',
                    r.waiting > 0 ? t.summaryWaiting.replace('{count}', String(r.waiting)) : '',
                    r.outstanding.length > 0 ? t.summaryRefused.replace('{count}', String(r.outstanding.length)) : '',
                ].filter(Boolean);
                line = t.statusLast.replace('{time}', new Date(st.last.at).toLocaleTimeString()).replace('{summary}', parts.length > 0 ? parts.join(', ') : t.summaryNothing);
            }
            status.setDesc(line);
            if (st.ownership === 'other') {
                status.descEl.createDiv({ text: t.otherDevice });
                status.addButton((b) => b.setButtonText(t.useThisDevice).onClick(async () => { const res = await runtime.claim(); if (!res.ok) new Notice(formatGuidance(describeError(this.plugin.t, res.error)), 8000); draw(); }));
            } else {
                status.addButton((b) => b.setButtonText(t.importNow).setCta().setDisabled(st.running).onClick(() => { void importFromClaudeNow(this.plugin); }));
            }
            if (st.corrupt) {
                new Setting(box).setName(t.resetName).setDesc(t.resetDesc).addButton((b) => b.setButtonText(t.resetButton).setWarning().onClick(async () => {
                    const res = await runtime.resetRecord();
                    new Notice(res.ok ? t.resetDone : formatGuidance(describeError(this.plugin.t, res.error)), 8000);
                    draw();
                }));
            }
        };
        this.unsubscribe?.();
        this.unsubscribe = runtime.subscribe(() => { if (box.isConnected) draw(); else { this.unsubscribe?.(); this.unsubscribe = null; } });
        draw();
    }
}
