import { ButtonComponent, FuzzySuggestModal, Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { getLanguageOptions, SupportedLanguage } from '../../i18n';
import { LanguageUtils } from '../../utils/languageUtils';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import {
    buildCommandCategories,
    type PickerCommand,
} from '../modals/CommandPickerModal';

const ESSENTIALS_MAX = 5;
const DEFAULT_ESSENTIALS = ['chat-with-ai', 'semantic-search', 'quick-peek'];

export class InterfaceSettingsSection extends BaseSettingSection {
    private initialLanguage!: SupportedLanguage;

    display(): void {
        // Store initial language to detect actual changes
        this.initialLanguage = this.plugin.settings.interfaceLanguage;

        // === Interface Language ===
        this.createSectionHeader(this.plugin.t.settings.interface.title, 'languages', 2);

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.interface.language)
            .setDesc(this.plugin.t.settings.interface.languageDesc)
            .addDropdown(dropdown => {
                const options = getLanguageOptions();

                return dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.interfaceLanguage)
                    .onChange((value) => {
                        this.plugin.settings.interfaceLanguage = value as SupportedLanguage;
                        void this.plugin.saveSettings();

                        // Only show restart notice if language actually changed from initial
                        if (value !== this.initialLanguage) {
                            this.showRestartNotice();
                        } else {
                            // Remove notice if reverted back to original
                            const existingNotice = this.containerEl.querySelector('.language-notice');
                            if (existingNotice) {
                                existingNotice.remove();
                            }
                        }
                    });
            });

        // === Output Language Settings ===
        this.containerEl.createEl('h2', { text: this.plugin.t.settings.interface.outputLanguage || 'Output language' });

        this.containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: this.plugin.t.settings.interface.outputLanguageDesc || 'Language for AI-generated content. Each feature can use this or have its own override.'
        });

        // Tag output language
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.outputLanguage || 'Tag generation language')
            .setDesc(this.plugin.t.settings.tagging.outputLanguageDesc || 'Language for generated tags')
            .addDropdown(dropdown => {
                const options: Record<string, string> = LanguageUtils.getLanguageOptions();

                return dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.language)
                    .onChange((value) => {
                        this.plugin.settings.language = value as typeof this.plugin.settings.language;
                        void this.plugin.saveSettings();
                    });
            });

        // Summary output language
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.summarization?.language || 'Summary language')
            .setDesc(this.plugin.t.settings.summarization?.languageDesc || 'Language for generated summaries')
            .addDropdown(dropdown => {
                for (const lang of COMMON_LANGUAGES) {
                    dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                }
                dropdown.setValue(this.plugin.settings.summaryLanguage || 'auto');
                dropdown.onChange(value => {
                    this.plugin.settings.summaryLanguage = value === 'auto' ? '' : value;
                    void this.plugin.saveSettings();
                });
            });

        // === Review Edits ===
        const re = this.plugin.t.modals.reviewEdits;
        new Setting(this.containerEl)
            .setName(re.settingName)
            .setDesc(re.settingDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReviewedEdits)
                .onChange(value => {
                    this.plugin.settings.enableReviewedEdits = value;
                    void this.plugin.saveSettings();
                }));

        // === Quick commands (configurable Essentials) ===
        this.renderQuickCommandsSection();
    }

    private renderQuickCommandsSection(): void {
        const t = this.plugin.t.settings.interface;
        this.createSectionHeader(t.essentialsTitle, 'star', 2);

        new Setting(this.containerEl)
            .setName(t.essentialsTitle)
            .setDesc(t.essentialsDesc);

        const listHost = this.containerEl.createDiv({ cls: 'ai-organiser-essentials-list' });
        this.renderEssentialsList(listHost);
    }

    /** Render the current Essentials selection + add/reset controls.
     *  Idempotent — called on initial display and after each mutation. */
    private renderEssentialsList(host: HTMLElement): void {
        host.empty();
        const t = this.plugin.t.settings.interface;
        const ids = this.plugin.settings.pickerEssentialsCommandIds ?? [];

        const allLeaves = this.collectAllLeaves();
        const leafById = new Map(allLeaves.map(l => [l.id, l]));

        // Render current pinned commands
        if (ids.length === 0) {
            host.createDiv({ cls: 'ai-organiser-essentials-empty', text: t.essentialsEmpty });
        } else {
            const rows = host.createDiv({ cls: 'ai-organiser-essentials-rows' });
            ids.forEach((id, idx) => {
                const leaf = leafById.get(id);
                if (!leaf) return;  // ignore stale ids silently
                const row = rows.createDiv({ cls: 'ai-organiser-essentials-row' });
                row.createSpan({ cls: 'ai-organiser-essentials-row-name', text: leaf.name });
                const removeBtn = row.createEl('button', {
                    cls: 'ai-organiser-essentials-row-remove',
                    text: '×',
                    attr: { type: 'button', 'aria-label': t.essentialsRemoveAria },
                });
                removeBtn.addEventListener('click', () => {
                    const next = ids.filter((_, i) => i !== idx);
                    this.plugin.settings.pickerEssentialsCommandIds = next;
                    void this.plugin.saveSettings();
                    this.renderEssentialsList(host);
                });
            });
        }

        // Action row
        const actions = host.createDiv({ cls: 'ai-organiser-essentials-actions' });
        const addBtn = new ButtonComponent(actions);
        addBtn.setButtonText(t.essentialsAddButton);
        addBtn.onClick(() => {
            if (ids.length >= ESSENTIALS_MAX) return;
            const used = new Set(ids);
            const candidates = allLeaves.filter(l => !used.has(l.id));
            const modal = new EssentialsPickerModal(
                this.plugin.app,
                candidates,
                t.essentialsPickerPlaceholder,
                (picked) => {
                    const next = [...ids, picked.id].slice(0, ESSENTIALS_MAX);
                    this.plugin.settings.pickerEssentialsCommandIds = next;
                    void this.plugin.saveSettings();
                    this.renderEssentialsList(host);
                },
            );
            modal.open();
        });
        if (ids.length >= ESSENTIALS_MAX) {
            addBtn.setDisabled(true);
            addBtn.setTooltip(t.essentialsLimitNotice);
        }

        if (ids.length > 0) {
            new ButtonComponent(actions)
                .setButtonText(t.essentialsResetButton)
                .onClick(() => {
                    this.plugin.settings.pickerEssentialsCommandIds = [];
                    void this.plugin.saveSettings();
                    this.renderEssentialsList(host);
                });
        }
    }

    /** Build the full leaf list from buildCommandCategories using empty
     *  Essentials override so we get every command exactly once (deduped
     *  by command.id since cross-listings reference the same object). */
    private collectAllLeaves(): PickerCommand[] {
        const cats = buildCommandCategories(
            this.plugin.t,
            () => { /* no-op — settings UI doesn't execute */ },
            DEFAULT_ESSENTIALS,
        );
        const seen = new Set<string>();
        const out: PickerCommand[] = [];
        const walk = (commands: PickerCommand[]) => {
            for (const c of commands) {
                if (c.subCommands && c.subCommands.length > 0) {
                    walk(c.subCommands);
                } else if (!seen.has(c.id)) {
                    seen.add(c.id);
                    out.push(c);
                }
            }
        };
        for (const cat of cats) walk(cat.commands);
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    /** Marker — the helper above is the public surface; the modal class is
     *  defined at module bottom so it can reference `PickerCommand` typing
     *  without polluting the class namespace. */
    private showRestartNotice(): void {
        // Remove any existing notice first
        const existingNotice = this.containerEl.querySelector('.language-notice');
        if (existingNotice) {
            existingNotice.remove();
        }

        const notice = document.createElement('div');
        notice.className = 'notice language-notice';
        notice.addClass('ai-organiser-mt-12');
        notice.setCssProps({ '--pad': '8px 12px' }); notice.addClass('ai-organiser-pad-custom');
        notice.setCssProps({ '--bg': 'var(--background-modifier-info)' }); notice.addClass('ai-organiser-bg-custom');
        notice.addClass('ai-organiser-border');
        notice.addClass('ai-organiser-rounded');
        notice.addClass('ai-organiser-text-normal');
        const row = notice.createDiv({ cls: 'ai-organiser-flex-row' });
        row.createSpan({ text: '\uD83D\uDCA1', cls: 'ai-organiser-icon-inline' });
        row.createSpan({ text: this.plugin.t.messages.languageChangeNotice });

        // Insert after the interface language setting, not at the end
        const firstSetting = this.containerEl.querySelector('.setting-item');
        if (firstSetting && firstSetting.nextSibling) {
            firstSetting.parentNode?.insertBefore(notice, firstSetting.nextSibling);
        } else {
            this.containerEl.appendChild(notice);
        }
    }
}

/**
 * Modal that lets the user pick a command to pin to Essentials. Reuses
 * Obsidian's `FuzzySuggestModal` for native search / keyboard navigation.
 */
class EssentialsPickerModal extends FuzzySuggestModal<PickerCommand> {
    private picked = false;

    constructor(
        app: import('obsidian').App,
        private readonly candidates: PickerCommand[],
        placeholder: string,
        private readonly onPick: (cmd: PickerCommand) => void,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    getItems(): PickerCommand[] {
        return this.candidates;
    }

    getItemText(item: PickerCommand): string {
        return item.name;
    }

    onChooseItem(item: PickerCommand): void {
        this.picked = true;
        this.onPick(item);
    }

    onClose(): void {
        super.onClose();
        // No-op on cancel — the caller's settings are untouched.
        if (!this.picked) return;
    }
}
