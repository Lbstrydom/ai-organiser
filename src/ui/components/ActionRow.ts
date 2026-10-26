/**
 * The one row used for "something is waiting for you": a title, an optional detail line and the actions that make sense.
 * The Process view draws every group with it; the hand-back and sweep reviews are meant to use the same component for their
 * item rows (a later step), so an action looks and behaves the same wherever it comes from.
 */
import { listen } from '../utils/domUtils';

export interface ActionRowButton {
    label: string;
    /** The first action is the primary one */
    onClick: () => void;
}

export interface ActionRowOptions {
    title: string;
    detail?: string;
    /** A line saying what the item is waiting on */
    held?: string;
    actions: readonly ActionRowButton[];
}

/** Draw one row into `list` and return a cleanup that releases its listeners. */
export function renderActionRow(list: HTMLElement, options: ActionRowOptions): () => void {
    const row = list.createEl('li', { cls: 'ai-organiser-action-row' });
    const text = row.createDiv({ cls: 'ai-organiser-action-row-text' });
    text.createDiv({ text: options.title, cls: 'ai-organiser-action-row-title' });
    if (options.detail) text.createDiv({ text: options.detail, cls: 'setting-item-description' });
    if (options.held) text.createDiv({ text: options.held, cls: 'setting-item-description ai-organiser-capture-warning' });
    const buttons = row.createDiv({ cls: 'ai-organiser-action-row-buttons' });
    const cleanups: Array<() => void> = [];
    options.actions.forEach((a, i) => {
        const b = buttons.createEl('button', { text: a.label, cls: i === 0 ? 'mod-cta' : '' });
        cleanups.push(listen(b, 'click', a.onClick));
    });
    return () => { for (const c of cleanups.splice(0)) c(); };
}
