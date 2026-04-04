import { App, Modal, Notice, setIcon } from 'obsidian';
import type { GlobalMemoryService } from '../../services/chat/globalMemoryService';
import type { Translations } from '../../i18n/types';

export class GlobalMemoryModal extends Modal {
    private items: string[] = [];

    constructor(
        app: App,
        private readonly memoryService: GlobalMemoryService,
        private readonly t: Translations['modals']['unifiedChat'],
        private readonly onSaved: (items: string[]) => void,
    ) { super(app); }

    async onOpen(): Promise<void> {
        this.items = await this.memoryService.loadMemory();
        this.render();
    }

    private render(): void {
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.setText(this.t.globalMemoryTitle);
        contentEl.addClass('ai-organiser-global-memory-modal');

        contentEl.createEl('p', { text: this.t.globalMemoryDescription, cls: 'ai-organiser-global-memory-desc' });

        const listEl = contentEl.createDiv({ cls: 'ai-organiser-global-memory-list' });
        this.renderList(listEl);
        this.renderAddRow(contentEl);
        this.renderActions(contentEl);
    }

    private renderList(container: HTMLElement): void {
        container.empty();
        if (this.items.length === 0) {
            container.createDiv({ cls: 'ai-organiser-global-memory-empty', text: this.t.globalMemoryEmpty });
            return;
        }
        for (const item of this.items) {
            const row = container.createDiv({ cls: 'ai-organiser-global-memory-row' });
            row.createSpan({ cls: 'ai-organiser-global-memory-text', text: item });
            const removeBtn = row.createEl('button', { cls: 'ai-organiser-global-memory-remove-btn' });
            setIcon(removeBtn, 'x');
            removeBtn.addEventListener('click', () => {
                this.items = this.items.filter(i => i !== item);
                this.render();
            });
        }
    }

    private renderAddRow(container: HTMLElement): void {
        const row = container.createDiv({ cls: 'ai-organiser-global-memory-add-row' });
        const input = row.createEl('input', {
            cls: 'ai-organiser-global-memory-add-input',
            attr: { placeholder: this.t.globalMemoryAddPlaceholder, type: 'text' },
        });

        const addBtn = row.createEl('button', { text: this.t.globalMemoryAdd });
        const doAdd = () => {
            const val = input.value.trim();
            if (!val) return;
            if (this.items.length >= 50) {
                new Notice(this.t.globalMemoryFull);
                return;
            }
            if (this.items.some(i => i.toLowerCase() === val.toLowerCase())) return;
            this.items.push(val);
            input.value = '';
            this.render();
        };
        addBtn.addEventListener('click', doAdd);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    }

    private renderActions(container: HTMLElement): void {
        const row = container.createDiv({ cls: 'ai-organiser-global-memory-actions' });
        const cancelBtn = row.createEl('button', { text: this.t.globalMemoryCancel });
        const saveBtn = row.createEl('button', { text: this.t.globalMemorySave, cls: 'mod-cta' });
        cancelBtn.addEventListener('click', () => this.close());
        saveBtn.addEventListener('click', () => { void (async () => {
            await this.memoryService.saveAll(this.items);
            this.onSaved(this.items);
            this.close();
        })(); });
    }

    onClose(): void { this.contentEl.empty(); }
}
