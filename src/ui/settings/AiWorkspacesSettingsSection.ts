import { ButtonComponent, Notice, Setting } from 'obsidian';
import { liveStatusText } from '../modals/LivePackReviewModal';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { normaliseShareFolders } from '../../services/aiWorkspaces/aiShareScope';
import { SharingSaver } from '../../services/aiWorkspaces/sharingSaver';
import { packFolderPath } from '../../services/aiWorkspaces/packStore';
import { logger } from '../../utils/logger';

/**
 * One saver per plugin, not per redraw: the settings page is rebuilt often, and two savers could overlap their saves. Sharing settings
 * are access control: saves run one at a time and a failed one puts back the last value that really saved (see SharingSaver).
 */
const savers = new WeakMap<AIOrganiserPlugin, SharingSaver>();
export function sharingSaverFor(plugin: AIOrganiserPlugin): SharingSaver {
    let saver = savers.get(plugin);
    if (!saver) {
        const s = plugin.settings;
        saver = new SharingSaver({
            read: () => ({ folders: s.aiShareFolders ?? [], optIn: s.aiShareRequireOptIn === true }),
            write: (v) => { s.aiShareFolders = [...v.folders]; s.aiShareRequireOptIn = v.optIn; },
            persist: () => plugin.saveSettings(),
            onFailed: (e) => {
                logger.error('AiWorkspaces', 'Could not save the sharing settings', e);
                new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 9000);
                plugin.settingTab?.display();
            },
        });
        savers.set(plugin, saver);
    }
    return saver;
}

/** AI workspaces: which folders may be shared with AI apps (default none), the opt-in for the connector, and the pack folder. */
export class AiWorkspacesSettingsSection extends BaseSettingSection {
    private delayRevision = 0;
    private delaySaved = 5;

    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const c = this.plugin.t.aiWorkspaces;
        const s = this.plugin.settings;
        // The saver remembers the values as they are NOW as the last saved ones, so it must exist before any handler below can edit them.
        sharingSaverFor(this.plugin);
        this.createSectionHeader(c.sectionTitle, 'messages-square', 2);
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });
        const saveSharing = (): void => { void sharingSaverFor(this.plugin).request(); };
        const save = (): void => { this.plugin.saveSettings().catch((e: unknown) => logger.error('AiWorkspaces', 'Could not save the settings', e)); };

        new Setting(this.containerEl).setName(c.shareFoldersName).setDesc(`${c.shareFoldersDesc} ${c.revokeNote}`)
            .addTextArea((ta) => {
                // The allow-list decides what leaves the vault, so half-typed lines are a draft: it takes effect when the field is left.
                let draft = (s.aiShareFolders ?? []).join('\n');
                ta.setPlaceholder(c.shareFoldersPlaceholder).setValue(draft).onChange((v) => { draft = v; });
                ta.inputEl.rows = 4;
                ta.inputEl.onblur = () => {
                    const next = normaliseShareFolders(draft.split('\n'));
                    if (JSON.stringify(next) === JSON.stringify(s.aiShareFolders ?? [])) return;
                    s.aiShareFolders = next;
                    saveSharing();
                };
            });

        new Setting(this.containerEl).setName(c.optInName).setDesc(c.optInDesc)
            .addToggle((tg) => tg.setValue(s.aiShareRequireOptIn === true).onChange((v) => { s.aiShareRequireOptIn = v; saveSharing(); }));

        new Setting(this.containerEl).setName(c.packFolderName).setDesc(c.packFolderDesc)
            .addText((tx) => {
                tx.setValue(s.aiWorkspacePackFolder).onChange((v) => {
                    const checked = packFolderPath(v, s.protectedFolders);
                    if (!checked.ok) { new Notice(formatGuidance(describeError(this.plugin.t, checked.error)), 8000); return; }
                    s.aiWorkspacePackFolder = checked.value;
                    save();
                });
                tx.inputEl.setAttribute('aria-label', c.packFolderName);
            });

        this.displayLive();
    }

    /** The live pack: everything here writes outside the vault, and says so. Desktop only. */
    private displayLive(): void {
        const t = this.plugin.t.aiWorkspaces.live;
        const s = this.plugin.settings;
        this.containerEl.createEl('h4', { text: t.sectionTitle });
        const runtime = this.plugin.livePacks;
        if (!runtime) { this.containerEl.createEl('p', { text: t.mobileNote, cls: 'setting-item-description' }); return; }
        const service = runtime.service;
        const inUse = service.ownedProjects().length > 0 || s.aiWorkspaceLiveRevocations.length > 0;
        new Setting(this.containerEl).setName(t.folderName).setDesc(t.folderDesc)
            .addText((tx) => {
                tx.setValue(s.aiWorkspaceLiveFolder);
                tx.inputEl.setAttribute('aria-label', t.folderName);
                tx.setDisabled(inUse);
                // A draft until the field is left, like the allow-list: a half-typed path is never saved.
                tx.inputEl.onblur = () => {
                    const next = tx.getValue().trim();
                    if (next === s.aiWorkspaceLiveFolder) return;
                    if (service.ownedProjects().length > 0 || s.aiWorkspaceLiveRevocations.length > 0) {
                        new Notice(formatGuidance(describeError(this.plugin.t, 'live-folder-in-use')), 9000);
                        tx.setValue(s.aiWorkspaceLiveFolder);
                        return;
                    }
                    const before = s.aiWorkspaceLiveFolder;
                    s.aiWorkspaceLiveFolder = next;
                    // Not saved = not changed: the previous value comes back and the person is told.
                    this.plugin.saveSettings().catch((e: unknown) => { logger.error('AiWorkspaces', 'Could not save the live pack folder', e); this.restore(() => { s.aiWorkspaceLiveFolder = before; }); });
                };
            })
            .addButton((b) => b.setButtonText(t.folderCheck).onClick(() => { void this.checkFolder(b); }));

        this.delaySaved = s.aiWorkspaceLiveDelayMinutes;
        new Setting(this.containerEl).setName(t.delayName).setDesc(t.delayDesc)
            .addSlider((sl) => sl.setLimits(1, 60, 1).setValue(s.aiWorkspaceLiveDelayMinutes).setDynamicTooltip().onChange((v) => {
                // The slider saves often: only the newest change may be undone, and only to the last value that really saved.
                const mine = ++this.delayRevision;
                s.aiWorkspaceLiveDelayMinutes = v;
                this.plugin.saveSettings().then(() => { if (mine === this.delayRevision) this.delaySaved = v; }, (e: unknown) => {
                    logger.error('AiWorkspaces', 'Could not save the live pack delay', e);
                    if (mine === this.delayRevision) this.restore(() => { s.aiWorkspaceLiveDelayMinutes = this.delaySaved; });
                });
            }));

        this.containerEl.createEl('h4', { text: t.statusHeading });
        const owned = service.ownedProjects();
        const pending = s.aiWorkspaceLiveRevocations.filter((r) => !owned.includes(r.aioId));
        if (owned.length === 0 && pending.length === 0) {
            this.containerEl.createEl('p', { text: t.statusNone, cls: 'setting-item-description' });
            return;
        }
        for (const id of owned) {
            const name = s.aiWorkspaces[id]?.live?.fileName ?? id;
            new Setting(this.containerEl).setName(name).setDesc(liveStatusText(this.plugin, id)).then((row) => row.descEl.setAttribute('role', 'status'));
        }
        for (const r of pending) new Setting(this.containerEl).setName(r.fileName).setDesc(t.stateRevoking);
    }

    /** A live pack setting that did not save: put the previous value back, say so, and show the real state. */
    private restore(undo: () => void): void {
        undo();
        new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 9000);
        this.plugin.settingTab?.display();
    }

    private async checkFolder(button: ButtonComponent): Promise<void> {
        const runtime = this.plugin.livePacks;
        if (!runtime) { new Notice(formatGuidance(describeError(this.plugin.t, 'live-desktop-only')), 8000); return; }
        button.setDisabled(true);
        try {
            const res = await runtime.checkFolder(this.plugin.settings.aiWorkspaceLiveFolder);
            new Notice(res.ok ? this.plugin.t.aiWorkspaces.live.folderOk : formatGuidance(describeError(this.plugin.t, res.error)), 8000);
        } finally {
            button.setDisabled(false);
        }
    }
}
