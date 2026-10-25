/**
 * The estimate and the privacy statement, shown before a manual run. Counts, megabytes of audio, images,
 * a cost range, and the plain warning that audio and images leave the machine before their content can be
 * checked against the keep-out words. Esc or Cancel runs nothing.
 *
 * The numbers describe what the run will really do: only captures that are ready, at most one run's worth,
 * and they are worked out again when the "Also process existing notes" box changes.
 */
import { App, ButtonComponent, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { plural } from '../../utils/plural';
import { listen } from '../utils/domUtils';

/** What one run would send. */
export interface RunEstimate {
    /** The captures this run sends: the run is limited to exactly these */
    ids: string[];
    /** Captures this run sends (already limited to one run's worth) */
    captures: number;
    /** Ready captures that do not fit in this run and wait for the next one */
    later: number;
    audioMB: number;
    images: number;
    cost: string;
}

export interface RunConfirmInfo {
    /** The estimate for the captures that are ready now */
    base: RunEstimate;
    /** The estimate when the existing (older) notes are included too */
    withExisting: RunEstimate;
    /** Captures one run handles at most */
    cap: number;
    /** Older notes ignored because they predate the setup */
    older: number;
    /** Captures still settling: a later run picks them up */
    settling: number;
}

export interface RunConfirmResult {
    confirmed: boolean;
    includeExisting: boolean;
}

export class CaptureRunConfirmModal extends Modal {
    private cleanups: (() => void)[] = [];
    private answered = false;
    private includeExisting = false;
    private summaryEl: HTMLElement | null = null;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly info: RunConfirmInfo, private readonly onResult: (r: RunConfirmResult) => void) {
        super(app);
    }

    /** The paragraphs that depend on the box: what is sent, what waits, what settles. */
    private describe(): string[] {
        const t = this.plugin.t.captureInbox;
        const { info } = this;
        const est = this.includeExisting ? info.withExisting : info.base;
        const lines: string[] = [];
        if (est.captures === 0) {
            lines.push(t.confirmNone);
        } else {
            lines.push(plural(t.confirmBody, est.captures, 'captures')
                .replace('{audioMB}', est.audioMB.toFixed(1))
                .replace('{images}', String(est.images))
                .replace('{cost}', est.cost));
        }
        if (est.later > 0) lines.push(plural(t.confirmLater, est.later, 'count').replace('{count}', String(est.later)).replace('{cap}', String(info.cap)));
        if (info.settling > 0) lines.push(plural(t.confirmSettling, info.settling, 'count').replace('{count}', String(info.settling)));
        return lines;
    }

    private drawSummary(): void {
        const el = this.summaryEl;
        if (!el) return;
        el.empty();
        for (const line of this.describe()) el.createEl('p', { text: line });
    }

    onOpen(): void {
        const t = this.plugin.t.captureInbox;
        const { contentEl, info } = this;
        this.containerEl.addClass('ai-organiser-modal-container');
        contentEl.addClass('ai-organiser-capture-confirm');
        contentEl.createEl('h3', { text: t.confirmTitle, cls: 'ai-organiser-modal-title' });
        this.summaryEl = contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
        this.drawSummary();
        contentEl.createEl('p', { text: t.confirmPrivacy, cls: 'ai-organiser-capture-warning' });

        if (info.older > 0) {
            contentEl.createEl('p', { text: plural(t.confirmOlder, info.older, 'count').replace('{count}', String(info.older)) });
            const row = contentEl.createDiv({ cls: 'ai-organiser-capture-checkrow' });
            const box = row.createEl('input', { type: 'checkbox', attr: { id: 'ai-organiser-capture-existing' } });
            row.createEl('label', { text: t.confirmOlderToggle, attr: { for: 'ai-organiser-capture-existing' } });
            this.cleanups.push(listen(box, 'change', () => { this.includeExisting = box.checked; this.drawSummary(); }));
        }

        const buttons = contentEl.createDiv('ai-organiser-modal-buttons');
        new ButtonComponent(buttons).setButtonText(this.plugin.t.modals.cancel).onClick(() => this.close());
        new ButtonComponent(buttons).setButtonText(this.plugin.t.modals.confirm).setCta().onClick(() => {
            this.answered = true;
            this.onResult({ confirmed: true, includeExisting: this.includeExisting });
            this.close();
        });
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.summaryEl = null;
        this.contentEl.empty();
        if (!this.answered) this.onResult({ confirmed: false, includeExisting: false });
    }
}
