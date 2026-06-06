import { App, ButtonComponent, FuzzySuggestModal, Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import {
    buildCommandCategories,
    type PickerCommand,
} from '../modals/CommandPickerModal';

const PINNED_MAX = 5;
const DEFAULT_PINNED = ['chat-with-ai', 'semantic-search', 'quick-peek'];

/**
 * Quick commands (configurable "Pinned" picks shown at the top of the command
 * picker). Lives in its own collapsible sub-section under Preferences so it
 * matches the collapsible structure of every other settings area.
 */
export class QuickCommandsSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.interface;
        // h2 is CSS-hidden inside a sub-collapsible (the summary is the header);
        // the Setting below supplies the visible name + description.
        this.createSectionHeader(t.pinnedTitle, 'star', 2);

        new Setting(this.containerEl)
            .setName(t.pinnedTitle)
            .setDesc(t.pinnedDesc);

        const listHost = this.containerEl.createDiv({ cls: 'ai-organiser-pinned-list' });
        this.renderPinnedList(listHost);
    }

    /** Render the current Pinned selection + add/reset controls.
     *  Idempotent — called on initial display and after each mutation. */
    private renderPinnedList(host: HTMLElement): void {
        host.empty();
        const t = this.plugin.t.settings.interface;
        const ids = this.plugin.settings.pickerPinnedCommandIds ?? [];

        const allLeaves = this.collectAllLeaves();
        const leafById = new Map(allLeaves.map(l => [l.id, l]));

        // Render current pinned commands
        if (ids.length === 0) {
            host.createDiv({ cls: 'ai-organiser-pinned-empty', text: t.pinnedEmpty });
        } else {
            const rows = host.createDiv({ cls: 'ai-organiser-pinned-rows' });
            ids.forEach((id, idx) => {
                const leaf = leafById.get(id);
                if (!leaf) return;  // ignore stale ids silently
                const row = rows.createDiv({ cls: 'ai-organiser-pinned-row' });
                row.createSpan({ cls: 'ai-organiser-pinned-row-name', text: leaf.name });
                const removeBtn = row.createEl('button', {
                    cls: 'ai-organiser-pinned-row-remove',
                    text: '×',
                    attr: { type: 'button', 'aria-label': t.pinnedRemoveAria },
                });
                removeBtn.addEventListener('click', () => {
                    const next = ids.filter((_, i) => i !== idx);
                    this.plugin.settings.pickerPinnedCommandIds = next;
                    void this.plugin.saveSettings();
                    this.renderPinnedList(host);
                });
            });
        }

        // Action row
        const actions = host.createDiv({ cls: 'ai-organiser-pinned-actions' });
        const addBtn = new ButtonComponent(actions);
        addBtn.setButtonText(t.pinnedAddButton);
        addBtn.onClick(() => {
            if (ids.length >= PINNED_MAX) return;
            const used = new Set(ids);
            const candidates = allLeaves.filter(l => !used.has(l.id));
            const modal = new PinnedPickerModal(
                this.plugin.app,
                candidates,
                t.pinnedPickerPlaceholder,
                (picked) => {
                    const next = [...ids, picked.id].slice(0, PINNED_MAX);
                    this.plugin.settings.pickerPinnedCommandIds = next;
                    void this.plugin.saveSettings();
                    this.renderPinnedList(host);
                },
            );
            modal.open();
        });
        if (ids.length >= PINNED_MAX) {
            addBtn.setDisabled(true);
            addBtn.setTooltip(t.pinnedLimitNotice);
        }

        if (ids.length > 0) {
            new ButtonComponent(actions)
                .setButtonText(t.pinnedResetButton)
                .onClick(() => {
                    this.plugin.settings.pickerPinnedCommandIds = [];
                    void this.plugin.saveSettings();
                    this.renderPinnedList(host);
                });
        }
    }

    /** Build the full leaf list from buildCommandCategories using empty
     *  Pinned override so we get every command exactly once (deduped
     *  by command.id since cross-listings reference the same object). */
    private collectAllLeaves(): PickerCommand[] {
        const cats = buildCommandCategories(
            this.plugin.t,
            () => { /* no-op — settings UI doesn't execute */ },
            DEFAULT_PINNED,
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
}

/**
 * Modal that lets the user pick a command to pin to Pinned. Reuses
 * Obsidian's `FuzzySuggestModal` for native search / keyboard navigation.
 */
class PinnedPickerModal extends FuzzySuggestModal<PickerCommand> {
    private picked = false;

    constructor(
        app: App,
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
