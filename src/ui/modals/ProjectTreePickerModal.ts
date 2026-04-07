import { App, Modal, Notice, setIcon } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { ProjectService, ProjectTreeNode, ProjectConfig } from '../../services/chat/projectService';
import { MAX_PROJECT_DEPTH } from '../../services/chat/projectService';
import { listen } from '../utils/domUtils';

export interface ProjectTreePickerCallbacks {
    onSelectProject: (projectId: string) => void;
    onLeaveProject: () => void;
}

export class ProjectTreePickerModal extends Modal {
    private t: Translations;
    private projectService: ProjectService;
    private callbacks: ProjectTreePickerCallbacks;
    private activeProjectId: string | undefined;

    private treeEl!: HTMLElement;
    private cleanups: (() => void)[] = [];
    private expandedGroups = new Set<string>();

    constructor(
        app: App,
        t: Translations,
        projectService: ProjectService,
        callbacks: ProjectTreePickerCallbacks,
        activeProjectId?: string,
    ) {
        super(app);
        this.t = t;
        this.projectService = projectService;
        this.callbacks = callbacks;
        this.activeProjectId = activeProjectId;
    }

    async onOpen(): Promise<void> {
        const { contentEl, modalEl } = this;
        modalEl.addClass('ai-organiser-project-tree-modal');
        contentEl.empty();

        // Header
        const header = contentEl.createDiv({ cls: 'ai-organiser-project-tree-header' });
        header.createEl('h3', { text: 'Select project' });

        // Tree container
        this.treeEl = contentEl.createDiv({ cls: 'ai-organiser-project-tree-container' });

        // Footer with action buttons
        const footer = contentEl.createDiv({ cls: 'ai-organiser-project-tree-footer' });

        const newProjectBtn = footer.createEl('button', { cls: 'mod-cta' });
        setIcon(newProjectBtn, 'folder-plus');
        newProjectBtn.createSpan({ text: ` ${'New project'}` });
        this.cleanups.push(listen(newProjectBtn, 'click', () => {
            void this.promptAndCreateProject();
        }));

        const newGroupBtn = footer.createEl('button');
        setIcon(newGroupBtn, 'folder');
        newGroupBtn.createSpan({ text: ` ${'New group'}` });
        this.cleanups.push(listen(newGroupBtn, 'click', () => {
            void this.promptAndCreateGroup();
        }));

        if (this.activeProjectId) {
            const leaveBtn = footer.createEl('button', { cls: 'mod-warning' });
            setIcon(leaveBtn, 'x');
            leaveBtn.createSpan({ text: ` ${'Leave project'}` });
            this.cleanups.push(listen(leaveBtn, 'click', () => {
                this.callbacks.onLeaveProject();
                this.close();
            }));
        }

        await this.renderTree();
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }

    private async renderTree(): Promise<void> {
        this.treeEl.empty();

        const result = await this.projectService.listProjectTree();
        if (!result.ok) {
            this.treeEl.createDiv({
                cls: 'ai-organiser-project-tree-empty',
                text: 'No projects yet',
            });
            return;
        }

        const nodes = result.value;
        if (nodes.length === 0) {
            this.treeEl.createDiv({
                cls: 'ai-organiser-project-tree-empty',
                text: 'No projects yet',
            });
            return;
        }

        this.renderNodes(this.treeEl, nodes);
    }

    private renderNodes(container: HTMLElement, nodes: ProjectTreeNode[]): void {
        for (const node of nodes) {
            if (node.type === 'group') {
                this.renderGroupNode(container, node);
            } else {
                this.renderProjectNode(container, node);
            }
        }
    }

    private renderGroupNode(container: HTMLElement, node: ProjectTreeNode): void {
        const isExpanded = this.expandedGroups.has(node.path);
        const row = container.createDiv({
            cls: 'ai-organiser-project-tree-row ai-organiser-project-tree-group',
        });
        row.style.paddingLeft = `${node.depth * 16 + 8}px`;

        const chevronEl = row.createSpan({ cls: 'ai-organiser-project-tree-chevron' });
        setIcon(chevronEl, isExpanded ? 'chevron-down' : 'chevron-right');

        const iconEl = row.createSpan({ cls: 'ai-organiser-project-tree-icon' });
        setIcon(iconEl, 'folder');

        row.createSpan({
            cls: 'ai-organiser-project-tree-name',
            text: node.name,
        });

        if (node.children.length === 0) {
            row.createSpan({
                cls: 'ai-organiser-project-tree-hint',
                text: 'Empty group',
            });
        }

        this.cleanups.push(listen(row, 'click', () => {
            if (isExpanded) {
                this.expandedGroups.delete(node.path);
            } else {
                this.expandedGroups.add(node.path);
            }
            void this.renderTree();
        }));

        if (isExpanded && node.children.length > 0) {
            const childContainer = container.createDiv({ cls: 'ai-organiser-project-tree-children' });
            this.renderNodes(childContainer, node.children);
        }
    }

    private renderProjectNode(container: HTMLElement, node: ProjectTreeNode): void {
        const isActive = node.project?.id === this.activeProjectId;
        const row = container.createDiv({
            cls: 'ai-organiser-project-tree-row ai-organiser-project-tree-project'
                + (isActive ? ' is-active' : ''),
        });
        row.style.paddingLeft = `${node.depth * 16 + 8}px`;

        const iconEl = row.createSpan({ cls: 'ai-organiser-project-tree-icon' });
        setIcon(iconEl, 'file-text');

        row.createSpan({
            cls: 'ai-organiser-project-tree-name',
            text: node.name,
        });

        if (isActive) {
            const badge = row.createSpan({ cls: 'ai-organiser-project-tree-active-badge' });
            badge.setText('\u2713');
        }

        if (node.project) {
            const projectId = node.project.id;
            this.cleanups.push(listen(row, 'click', () => {
                this.callbacks.onSelectProject(projectId);
                this.close();
            }));
        }
    }

    private async promptAndCreateProject(parentPath?: string): Promise<void> {
        const name = await this.inlinePrompt('New project');
        if (!name) return;

        if (parentPath) {
            const result = await this.projectService.createProjectInGroup(name, parentPath);
            if (!result.ok) {
                new Notice(result.error);
                return;
            }
            this.callbacks.onSelectProject(result.value);
        } else {
            const projectId = await this.projectService.createProject(name);
            this.callbacks.onSelectProject(projectId);
        }
        this.close();
    }

    private async promptAndCreateGroup(parentPath?: string): Promise<void> {
        const name = await this.inlinePrompt('New group');
        if (!name) return;

        const result = await this.projectService.createGroup(name, parentPath);
        if (!result.ok) {
            new Notice(result.error);
            return;
        }
        await this.renderTree();
    }

    private inlinePrompt(placeholder: string): Promise<string | null> {
        return new Promise(resolve => {
            const wrapper = this.contentEl.createDiv({ cls: 'ai-organiser-inline-prompt' });
            const input = wrapper.createEl('input', {
                attr: { type: 'text', placeholder },
            });
            const okBtn = wrapper.createEl('button', {
                cls: 'mod-cta',
                text: this.t.common.confirm,
            });
            const cancelBtn = wrapper.createEl('button', {
                text: this.t.common.cancel,
            });

            const done = (v: string | null) => { wrapper.remove(); resolve(v); };
            this.cleanups.push(listen(okBtn, 'click', () => done(input.value.trim() || null)));
            this.cleanups.push(listen(cancelBtn, 'click', () => done(null)));
            this.cleanups.push(listen(input, 'keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter') done(input.value.trim() || null);
                if (e.key === 'Escape') done(null);
            }));
            input.focus();
        });
    }
}
