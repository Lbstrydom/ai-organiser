import { App, Modal } from 'obsidian';
import type { ProjectConfig } from '../../services/chat/projectService';
import type { ProjectService } from '../../services/chat/projectService';
import type { Translations } from '../../i18n/types';
import { listen } from '../utils/domUtils';
import { ConfirmationModal } from './ConfirmationModal';

export class ProjectSettingsModal extends Modal {
    private localConfig: ProjectConfig;
    private cleanups: (() => void)[] = [];

    constructor(
        app: App,
        private readonly projectService: ProjectService,
        private readonly config: ProjectConfig,
        private readonly t: Translations['modals']['unifiedChat'],
        private readonly onSaved: (config: ProjectConfig) => void,
    ) {
        super(app);
        this.localConfig = { ...config, memory: [...config.memory], pinnedFiles: [...config.pinnedFiles] };
    }

    onOpen(): void {
        this.render();
    }

    private render(): void {
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.setText(this.t.projectSettings);
        contentEl.addClass('ai-organiser-project-settings-modal');

        // Instructions
        contentEl.createEl('h4', { text: this.t.projectInstructions });
        contentEl.createEl('p', { cls: 'setting-item-description', text: this.t.projectInstructionsDesc });
        const instrArea = contentEl.createEl('textarea', {
            cls: 'ai-organiser-project-settings-textarea',
            attr: { rows: '6', placeholder: this.t.projectInstructionsDesc },
        });
        instrArea.value = this.localConfig.instructions;
        this.cleanups.push(listen(instrArea, 'input', () => {
            this.localConfig.instructions = instrArea.value;
        }));

        // Memory
        contentEl.createEl('h4', { text: this.t.projectMemory });
        contentEl.createEl('p', { cls: 'setting-item-description', text: this.t.projectMemoryDesc });
        const memList = contentEl.createDiv({ cls: 'ai-organiser-project-settings-list' });
        this.renderMemoryList(memList);

        // Pinned Files
        contentEl.createEl('h4', { text: this.t.projectPinnedFiles });
        contentEl.createEl('p', { cls: 'setting-item-description', text: this.t.projectPinnedFilesDesc });
        const pinnedList = contentEl.createDiv({ cls: 'ai-organiser-project-settings-list' });
        this.renderPinnedList(pinnedList);

        // Actions
        const actions = contentEl.createDiv({ cls: 'ai-organiser-project-settings-actions' });
        const deleteBtn = actions.createEl('button', { text: this.t.projectDelete, cls: 'mod-warning' });
        const saveBtn = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });

        this.cleanups.push(listen(deleteBtn, 'click', () => {
            new ConfirmationModal(
                this.app,
                'Delete Project',
                this.t.projectDeleteConfirm.replace('{name}', this.localConfig.name),
                () => { void (async () => {
                    await this.projectService.deleteProject(this.localConfig.id);
                    this.close();
                })(); }
            ).open();
        }));

        this.cleanups.push(listen(saveBtn, 'click', () => { void (async () => {
            await this.projectService.updateProject(this.localConfig.id, {
                instructions: this.localConfig.instructions,
                memory: this.localConfig.memory,
                pinnedFiles: this.localConfig.pinnedFiles,
            });
            this.onSaved(this.localConfig);
            this.close();
        })(); }));
    }

    private renderMemoryList(container: HTMLElement): void {
        container.empty();
        if (this.localConfig.memory.length === 0) {
            container.createDiv({ cls: 'ai-organiser-project-settings-empty', text: this.t.projectMemoryEmpty });
        } else {
            for (let i = 0; i < this.localConfig.memory.length; i++) {
                const item = this.localConfig.memory[i];
                const row = container.createDiv({ cls: 'ai-organiser-project-settings-item-row' });
                row.createSpan({ text: item, cls: 'ai-organiser-project-settings-item-text' });
                const removeBtn = row.createEl('button', { text: this.t.projectMemoryRemove });
                const idx = i;
                this.cleanups.push(listen(removeBtn, 'click', () => {
                    this.localConfig.memory.splice(idx, 1);
                    this.renderMemoryList(container);
                }));
            }
        }

        // Add row
        const addRow = container.createDiv({ cls: 'ai-organiser-project-settings-add-row' });
        const input = addRow.createEl('input', {
            attr: { type: 'text', placeholder: this.t.projectMemoryAdd },
        });
        const addBtn = addRow.createEl('button', { text: '+' });
        const doAdd = () => {
            const val = input.value.trim();
            if (!val) return;
            this.localConfig.memory.push(val);
            input.value = '';
            this.renderMemoryList(container);
        };
        this.cleanups.push(listen(addBtn, 'click', doAdd));
        this.cleanups.push(listen(input, 'keydown', e => { if (e.key === 'Enter') doAdd(); }));
    }

    private renderPinnedList(container: HTMLElement): void {
        container.empty();
        if (this.localConfig.pinnedFiles.length === 0) {
            container.createDiv({ cls: 'ai-organiser-project-settings-empty', text: this.t.projectPinnedEmpty });
        } else {
            for (let i = 0; i < this.localConfig.pinnedFiles.length; i++) {
                const file = this.localConfig.pinnedFiles[i];
                const row = container.createDiv({ cls: 'ai-organiser-project-settings-item-row' });
                row.createSpan({ text: `[[${file}]]`, cls: 'ai-organiser-project-settings-item-text' });
                const removeBtn = row.createEl('button', { text: this.t.projectPinnedRemove });
                const idx = i;
                this.cleanups.push(listen(removeBtn, 'click', () => {
                    this.localConfig.pinnedFiles.splice(idx, 1);
                    this.renderPinnedList(container);
                }));
            }
        }

        const addRow = container.createDiv({ cls: 'ai-organiser-project-settings-add-row' });
        const input = addRow.createEl('input', {
            attr: { type: 'text', placeholder: '[[Note title]]' }, // eslint-disable-line obsidianmd/ui/sentence-case -- wikilink syntax
        });
        const addBtn = addRow.createEl('button', { text: '+' });
        const doAdd = () => {
            const val = input.value.replace(/^\[\[|\]\]$/g, '').trim();
            if (!val) return;
            this.localConfig.pinnedFiles.push(val);
            input.value = '';
            this.renderPinnedList(container);
        };
        this.cleanups.push(listen(addBtn, 'click', doAdd));
        this.cleanups.push(listen(input, 'keydown', e => { if (e.key === 'Enter') doAdd(); }));
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }
}
