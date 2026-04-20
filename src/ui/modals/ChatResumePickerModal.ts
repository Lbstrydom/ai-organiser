import { App, Modal, setIcon } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import type { ConversationSummary } from '../../utils/chatExportUtils';
import type { ConversationPersistenceService } from '../../services/chat/conversationPersistenceService';
import type { ProjectConfig, ProjectService } from '../../services/chat/projectService';
import type { Translations } from '../../i18n/types';
import type { ChatMode } from '../chat/ChatModeHandler';

export type ResumePickerResult =
    | { action: 'resume'; filePath: string; projectId?: string }
    | { action: 'new'; initialMode?: ChatMode }
    | { action: 'new-in-project'; projectId: string }
    | { action: 'create-project'; name: string }
    | null;

/** Action returned when user makes a selection in the resume picker. */
export type ResumeAction =
    | { type: 'new' }
    | { type: 'cancel' }
    | { type: 'resume'; filePath: string; state: import('../../utils/chatExportUtils').ConversationState }
    | { type: 'new-in-project'; projectId: string }
    | { type: 'new-project' };

export class ChatResumePickerModal extends Modal {
    private result: ResumePickerResult = null;
    private resolvePromise: ((result: ResumePickerResult) => void) | null = null;

    constructor(
        app: App,
        private readonly persistenceService: ConversationPersistenceService,
        private readonly projectService: ProjectService,
        private readonly settings: AIOrganiserSettings,
        private readonly t: Translations['modals']['unifiedChat'],
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.t.resumeTitle);
        contentEl.addClass('ai-organiser-resume-picker-modal');
        contentEl.empty();

        const [projects, conversations] = await Promise.all([
            this.projectService.listProjects(),
            this.persistenceService.listRecent(20),
        ]);

        if (projects.length === 0 && conversations.length === 0) {
            // Nothing to show — resolve immediately with new
            this.resolve({ action: 'new' });
            this.close();
            return;
        }

        // 1. Action rows at the TOP (user feedback 2026-04-20 — mirrors the
        //    Claude / ChatGPT web pattern: "start something new" is the
        //    primary affordance, history is the reference shelf below).
        const newBtn = contentEl.createDiv({ cls: 'ai-organiser-resume-action-row' });
        setIcon(newBtn.createSpan({ cls: 'ai-organiser-resume-row-icon' }), 'message-square-plus');
        newBtn.createSpan({ text: this.t.resumeNewConversation });
        newBtn.addEventListener('click', () => {
            this.resolve({ action: 'new' });
            this.close();
        });

        const newPresBtn = contentEl.createDiv({ cls: 'ai-organiser-resume-action-row' });
        setIcon(newPresBtn.createSpan({ cls: 'ai-organiser-resume-row-icon' }), 'presentation');
        newPresBtn.createSpan({ text: this.t.resumeNewPresentation });
        newPresBtn.addEventListener('click', () => {
            this.resolve({ action: 'new', initialMode: 'presentation' });
            this.close();
        });

        const newProjectBtn = contentEl.createDiv({ cls: 'ai-organiser-resume-action-row' });
        setIcon(newProjectBtn.createSpan({ cls: 'ai-organiser-resume-row-icon' }), 'folder-plus');
        newProjectBtn.createSpan({ text: this.t.resumeNewProject });
        newProjectBtn.addEventListener('click', () => { void this.handleCreateProject(); });

        // 2. Projects — collapsible <details>, collapsed by default so history
        //    doesn't compete visually with the new-action buttons above.
        if (projects.length > 0) {
            const details = contentEl.createEl('details', { cls: 'ai-organiser-resume-collapsible' });
            const summary = details.createEl('summary', { cls: 'ai-organiser-resume-section-header' });
            summary.createSpan({ text: this.t.resumeProjects });
            summary.createSpan({
                cls: 'ai-organiser-resume-section-count',
                text: ` (${projects.length})`,
            });
            for (const project of projects) {
                await this.renderProjectRow(details, project);
            }
        }

        // 3. Recent conversations — collapsible, collapsed by default.
        const unfiled = conversations.filter(c => !c.projectId);
        if (unfiled.length > 0) {
            const details = contentEl.createEl('details', { cls: 'ai-organiser-resume-collapsible' });
            const summary = details.createEl('summary', { cls: 'ai-organiser-resume-section-header' });
            summary.createSpan({ text: this.t.resumeRecent });
            summary.createSpan({
                cls: 'ai-organiser-resume-section-count',
                text: ` (${unfiled.length})`,
            });
            for (const conv of unfiled) {
                this.renderConversationRow(details, conv);
            }
        }

        // Keyboard navigation
        this.setupKeyboardNav(contentEl);
    }

    waitForResult(): Promise<ResumePickerResult> {
        return new Promise(resolve => { this.resolvePromise = resolve; });
    }

    onClose(): void {
        // ESC = new conversation
        if (!this.result) {
            this.resolvePromise?.({ action: 'new' });
        }
        this.contentEl.empty();
    }

    private async renderProjectRow(container: HTMLElement, project: ProjectConfig): Promise<void> {
        const count = await this.projectService.countConversations(project.id);
        const row = container.createDiv({ cls: 'ai-organiser-resume-project-row' });

        const iconEl = row.createSpan({ cls: 'ai-organiser-resume-row-icon' });
        setIcon(iconEl, 'folder');
        row.createSpan({ cls: 'ai-organiser-resume-row-title', text: project.name });
        row.createSpan({
            cls: 'ai-organiser-resume-row-meta',
            text: this.t.resumeProjectChats.replace('{count}', String(count)),
        });

        row.addEventListener('click', () => {
            this.resolve({ action: 'new-in-project', projectId: project.id });
            this.close();
        });
    }

    private renderConversationRow(container: HTMLElement, conv: ConversationSummary): void {
        const row = container.createDiv({ cls: 'ai-organiser-resume-conv-row' });

        const iconEl = row.createSpan({ cls: 'ai-organiser-resume-row-icon' });
        setIcon(iconEl, conv.mode === 'presentation' ? 'layout-template' : 'message-square');
        const titleSpan = row.createSpan({ cls: 'ai-organiser-resume-row-title', text: conv.title });

        const meta = this.formatTimeAgo(conv.updatedAt ?? conv.lastActiveAt ?? new Date().toISOString());
        const slidePart = conv.slideCount
            ? `${this.t.resumeSlides.replace('{count}', String(conv.slideCount))} · `
            : '';
        row.createSpan({
            cls: 'ai-organiser-resume-row-meta',
            text: `${slidePart}${this.t.resumeMessages.replace('{count}', String(conv.messageCount))} · ${meta}`,
        });

        // Rename button — pencil icon, stops row click from firing
        const renameBtn = row.createSpan({ cls: 'ai-organiser-resume-row-rename', attr: { 'aria-label': this.t.resumeRename } });
        setIcon(renameBtn, 'pencil');
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleInlineRename(conv, row, titleSpan);
        });

        row.addEventListener('click', () => {
            this.resolve({ action: 'resume', filePath: conv.filePath, projectId: conv.projectId });
            this.close();
        });
    }

    private handleInlineRename(conv: ConversationSummary, row: HTMLElement, titleSpan: HTMLElement): void {
        // Replace title span with an inline input
        const input = document.createElement('input');
        input.type = 'text';
        input.value = conv.title;
        input.className = 'ai-organiser-resume-rename-input';
        titleSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== conv.title) {
                await this.persistenceService.renameConversation(conv.filePath, newTitle);
                conv.title = newTitle;
            }
            const restored = document.createElement('span');
            restored.className = 'ai-organiser-resume-row-title';
            restored.textContent = conv.title;
            input.replaceWith(restored);
        };

        const cancel = () => {
            const restored = document.createElement('span');
            restored.className = 'ai-organiser-resume-row-title';
            restored.textContent = conv.title;
            input.replaceWith(restored);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            e.stopPropagation(); // prevent row keyboard nav from intercepting
        });
        input.addEventListener('blur', () => { void commit(); });
        // Stop click inside input from triggering the row resume
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    private async handleCreateProject(): Promise<void> {
        const name = await this.promptProjectName();
        if (!name) return;
        this.resolve({ action: 'create-project', name });
        this.close();
    }

    private promptProjectName(): Promise<string | null> {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = this.t.resumeProjectName;
            // Simple inline prompt in modal footer
            const footer = this.contentEl.createDiv({ cls: 'ai-organiser-resume-project-name-row' });
            footer.appendChild(input);

            const createBtn = footer.createEl('button', { text: this.t.resumeProjectCreate, cls: 'mod-cta' });
            const cancelBtn = footer.createEl('button', { text: this.t.resumeProjectCancel });

            const done = (value: string | null) => {
                footer.remove();
                resolve(value);
            };

            createBtn.addEventListener('click', () => done(input.value.trim() || null));
            cancelBtn.addEventListener('click', () => done(null));
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') done(input.value.trim() || null);
                if (e.key === 'Escape') done(null);
            });
            input.focus();
        });
    }

    private resolve(result: ResumePickerResult): void {
        this.result = result;
        this.resolvePromise?.(result);
    }

    private formatTimeAgo(isoString: string): string {
        const diff = Date.now() - new Date(isoString).getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        let time = '';
        if (days > 0) time = `${days}d`;
        else if (hours > 0) time = `${hours}h`;
        else time = `${minutes}m`;
        return this.t.resumeTimeAgo.replace('{time}', time);
    }

    private setupKeyboardNav(container: HTMLElement): void {
        const rows = () => Array.from(container.querySelectorAll<HTMLElement>(
            '.ai-organiser-resume-project-row, .ai-organiser-resume-conv-row, .ai-organiser-resume-action-row'
        ));

        container.addEventListener('keydown', (e) => {
            const all = rows();
            const focused = document.activeElement as HTMLElement;
            const idx = all.indexOf(focused);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                all[Math.min(idx + 1, all.length - 1)]?.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                all[Math.max(idx - 1, 0)]?.focus();
            } else if (e.key === 'Enter' && idx >= 0) {
                e.preventDefault();
                all[idx].click();
            }
        });

        rows().forEach(row => row.setAttribute('tabindex', '0'));
    }
}
