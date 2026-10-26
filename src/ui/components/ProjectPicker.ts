/**
 * The shared project picker: one searchable list (title, folder, root kind, status, pairing badge) used by every flow that
 * needs a project (opening one, the hand-back review, later filing and reconcile). It shows why a candidate is suggested and
 * never pre-selects an ambiguous match: a suggestion is only highlighted when the caller says it is clearly ahead.
 */
import { App, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { searchProjects, type ProjectRef } from '../../services/projects/projectIndex';
import { listen } from '../utils/domUtils';
import { plural } from '../../utils/plural';

export interface ProjectPickerOptions {
    plugin: AIOrganiserPlugin;
    projects: readonly ProjectRef[];
    onChoose(project: ProjectRef): void;
    /** A candidate the caller found clearly ahead, with the reason shown beside it. Absent: no default. */
    suggested?: { aioId: string; reason: string };
    /** Duplicated ids that were left out of `projects`, said once under the list */
    duplicateCount?: number;
    /** Notes with an id but no role */
    unadoptedCount?: number;
}

const titleOf = (p: ProjectRef): string => p.notePath.slice(p.notePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');

/** Render the picker into `container`. Returns a cleanup that releases every listener. */
export function renderProjectPicker(container: HTMLElement, options: ProjectPickerOptions): () => void {
    const t = options.plugin.t.projects;
    const cleanups: Array<() => void> = [];
    container.addClass('ai-organiser-project-picker');
    const input = container.createEl('input', { type: 'text', attr: { 'aria-label': t.pickerPlaceholder, placeholder: t.pickerPlaceholder } });
    input.addClass('ai-organiser-project-picker-search');
    const list = container.createEl('ul', { cls: 'ai-organiser-project-picker-list', attr: { 'aria-label': t.pickerTitle } });
    const notes = container.createDiv({ cls: 'setting-item-description' });

    const draw = (): void => {
        list.empty();
        const matches = searchProjects(options.projects, input.value);
        if (options.projects.length === 0) list.createEl('li', { text: t.pickerEmpty, cls: 'ai-organiser-project-picker-empty' });
        else if (matches.length === 0) list.createEl('li', { text: t.pickerNoMatch, cls: 'ai-organiser-project-picker-empty' });
        for (const project of matches) {
            const item = list.createEl('li', { cls: 'ai-organiser-project-picker-item' });
            const button = item.createEl('button', { cls: 'ai-organiser-project-picker-button' });
            if (options.suggested?.aioId === project.aioId) button.addClass('mod-cta');
            button.createDiv({ text: titleOf(project), cls: 'ai-organiser-project-picker-title' });
            const detail = [
                project.folder || '/',
                project.rootKind ? t.rootKinds[project.rootKind] : '',
                project.status || t.statusNone,
                t.pairing[project.pairing],
            ].filter(Boolean).join(' · ');
            button.createDiv({ text: detail, cls: 'setting-item-description ai-organiser-project-picker-detail' });
            if (options.suggested?.aioId === project.aioId) button.createDiv({ text: options.suggested.reason, cls: 'setting-item-description ai-organiser-project-picker-reason' });
            cleanups.push(listen(button, 'click', () => options.onChoose(project)));
        }
        notes.empty();
        if (options.duplicateCount) notes.createDiv({ text: plural(t.duplicateNote, options.duplicateCount) });
        if (options.unadoptedCount) notes.createDiv({ text: plural(t.unadoptedNote, options.unadoptedCount) });
    };
    const redraw = (): void => {
        // The row listeners belong to the rows just replaced; release them with them.
        for (const cleanup of cleanups.splice(1)) cleanup();
        draw();
    };
    cleanups.push(listen(input, 'input', redraw));
    draw();
    return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}

export class ProjectPickerModal extends Modal {
    private cleanup: (() => void) | null = null;
    private chosen = false;

    constructor(app: App, private readonly options: ProjectPickerOptions, private readonly onCancel?: () => void) {
        super(app);
    }

    onOpen(): void {
        // One opening, one outcome: a reused instance starts again as not chosen.
        this.chosen = false;
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.createEl('h3', { text: this.options.plugin.t.projects.pickerTitle, cls: 'ai-organiser-modal-title' });
        const body = this.contentEl.createDiv();
        this.cleanup = renderProjectPicker(body, {
            ...this.options,
            onChoose: (project) => { this.chosen = true; this.close(); this.options.onChoose(project); },
        });
    }

    onClose(): void {
        this.cleanup?.();
        this.cleanup = null;
        this.contentEl.empty();
        if (!this.chosen) this.onCancel?.();
    }
}
