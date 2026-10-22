/**
 * GuidedSetupModal: the shared stepper behind every feature's "Set up" button.
 *
 * Behaviour lives in `SetupFlow` (pure, tested). This class renders the current step, the
 * "Step 2 of 4" heading (focused on every move so screen readers announce it), the
 * Back / Next / Finish buttons and an inline error taken from `describeError`.
 * Esc or the close button cancels and saves nothing.
 */
import { App, Modal } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { Result } from '../../core/result';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { SetupFlow, type FlowStep } from '../setup/setupFlow';
import { listen } from '../utils/domUtils';

export interface GuidedStep extends FlowStep {
    title: string;
    /** Draw the step body. Called every time the step is shown. */
    render: (container: HTMLElement) => void | Promise<void>;
}

export interface GuidedSetupOptions {
    title: string;
    steps: readonly GuidedStep[];
    /** Persist everything. Called once, from Finish. */
    onFinish: () => Result<void> | Promise<Result<void>>;
    /** Called when the modal closes without finishing (discard drafts here). */
    onCancel?: () => void;
}

export class GuidedSetupModal extends Modal {
    private readonly flow: SetupFlow;
    private cleanups: (() => void)[] = [];
    private errorEl: HTMLElement | null = null;
    private busy = false;

    constructor(
        app: App,
        private readonly t: Translations,
        private readonly opts: GuidedSetupOptions,
    ) {
        super(app);
        this.flow = new SetupFlow(opts.steps, opts.onFinish);
    }

    onOpen(): void {
        void this.draw();
    }

    private async draw(): Promise<void> {
        const { contentEl } = this;
        this.runCleanups();
        contentEl.empty();
        const step = this.opts.steps[this.flow.stepIndex];

        contentEl.createEl('h2', { text: this.opts.title });
        const heading = contentEl.createEl('h3', {
            text: `${this.t.setup.stepLabel
                .replace('{current}', String(this.flow.stepIndex + 1))
                .replace('{total}', String(this.flow.stepCount))} — ${step.title}`,
            attr: { tabindex: '-1' },
        });

        const body = contentEl.createDiv({ cls: 'ai-organiser-setup-body' });
        await step.render(body);

        this.errorEl = contentEl.createDiv({ cls: 'ai-organiser-setup-error', attr: { role: 'alert' } });

        const buttons = contentEl.createDiv({ cls: 'ai-organiser-setup-buttons' });
        if (!this.flow.isFirst) {
            this.addButton(buttons, this.t.setup.back, () => { this.flow.back(); void this.draw(); });
        }
        this.addButton(buttons, this.t.setup.cancel, () => this.close());
        if (this.flow.isLast) {
            this.addButton(buttons, this.t.setup.finish, () => { void this.finish(); }, true);
        } else {
            this.addButton(buttons, this.t.setup.next, () => { void this.next(); }, true);
        }
        heading.focus();
    }

    private addButton(parent: HTMLElement, text: string, onClick: () => void, cta = false): void {
        const btn = parent.createEl('button', { text, cls: cta ? 'mod-cta' : '', attr: { type: 'button', 'aria-label': text } });
        this.cleanups.push(listen(btn, 'click', () => { if (!this.busy) onClick(); }));
    }

    private async next(): Promise<void> {
        this.busy = true;
        try {
            const res = await this.flow.next();
            if (!res.ok) { this.showError(res.error); return; }
            await this.draw();
        } finally {
            this.busy = false;
        }
    }

    private async finish(): Promise<void> {
        this.busy = true;
        try {
            const res = await this.flow.finish();
            if (!res.ok) { this.showError(res.error); return; }
            this.close();
        } finally {
            this.busy = false;
        }
    }

    private showError(code: string): void {
        this.errorEl?.setText(formatGuidance(describeError(this.t, code)));
    }

    private runCleanups(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }

    onClose(): void {
        if (!this.flow.isFinished) {
            this.flow.cancel();
            this.opts.onCancel?.();
        }
        this.runCleanups();
        this.contentEl.empty();
    }
}
