/**
 * PolishSelectorModal — per-slide polish selection surface.
 *
 * Pure UI component (Inversion-of-Control): it collects the user's draft and
 * hands it to `opts.onSubmit`; the handler runs the LLM call and reports back
 * via the returned Result. The modal stays open through the call so the draft
 * is preserved on any failure (plan §5, audit-r1 H1) — the user can edit and
 * retry without re-entering anything.
 *
 * Lifecycle follows `src/ui/modals/_conventions.md`: every listener registered
 * via `listen()` and disposed in `onClose()`; the abort controller cancels the
 * in-flight LLM call when the modal closes.
 *
 * Internal `slideIndex` is 0-based throughout; UI-displayed numbers are
 * 1-based, converted at the seam (plan §4.2b indexing convention).
 *
 * Plan: docs/plans/per-slide-polish.md
 */

import { App, Modal } from 'obsidian';
import { listen } from '../utils/domUtils';
import type { SlideDeckIr } from '../../services/presentationIr/slideIr';
import type { QualityFinding } from '../../services/chat/presentationTypes';
import type { Translations } from '../../i18n/types';

export type PolishSelection = { slideIndex: number; instruction: string };

export type PolishSubmit =
    | { kind: 'all' }
    | { kind: 'selective'; selections: PolishSelection[] };

export interface PolishSelectorOptions {
    /** Called when the user clicks the action button. Returns a Result-like
     *  promise so the modal decides whether to close (ok) or re-enable the
     *  form with an error banner (err). Throwing is treated as err. */
    onSubmit: (draft: PolishSubmit, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Invoked once from `onClose()`, after abort + cleanups have fired. The
     *  handler uses this to clear its single-flight `activePolish` record
     *  (gemini-gate r2 F2 + audit-r3 H3). */
    onClose?: () => void;
}

type PolishSelectorT = Translations['modals']['polishSelector'];

export class PolishSelectorModal extends Modal {
    private rowStates: Array<{ checked: boolean; instruction: string }>;
    private allSlidesChecked = false;
    private submitting = false;
    private errorMessage: string | null = null;
    private readonly cleanups: Array<() => void> = [];
    private readonly abortController = new AbortController();

    // DOM refs (built in onOpen).
    private allSlidesCheckboxEl: HTMLInputElement | null = null;
    private rowCheckboxEls: HTMLInputElement[] = [];
    private rowTextareaEls: HTMLTextAreaElement[] = [];
    private actionBtnEl: HTMLButtonElement | null = null;
    private cancelBtnEl: HTMLButtonElement | null = null;
    private errorBannerEl: HTMLElement | null = null;

    constructor(
        app: App,
        private readonly deck: SlideDeckIr,
        private readonly findings: readonly QualityFinding[],
        private readonly t: PolishSelectorT,
        private readonly opts: PolishSelectorOptions,
    ) {
        super(app);
        this.rowStates = deck.slides.map((_, i) => ({
            checked: false,
            instruction: formatFindingsForSlide(findings, i),
        }));
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.t.title);
        contentEl.empty();
        contentEl.addClass('ai-organiser-polish-selector');

        // Privacy notice — always rendered (audit-r1 M3).
        contentEl.createEl('div', {
            cls: 'ai-organiser-polish-privacy',
            text: this.t.privacyNotice,
            attr: { role: 'note' },
        });

        // Deck-wide findings (slideIndex === undefined) — read-only (plan §4.6.2).
        const deckWide = this.findings.filter(f => f.slideIndex === undefined);
        if (deckWide.length > 0) {
            const wrap = contentEl.createEl('div', { cls: 'ai-organiser-polish-deckwide' });
            wrap.createEl('h4', { cls: 'ai-organiser-polish-deckwide-heading', text: this.t.deckWideFindingsHeading });
            for (const f of deckWide) {
                wrap.createEl('div', {
                    cls: 'ai-organiser-polish-deckwide-line',
                    text: `[${f.severity}] ${f.issue} → ${f.suggestion}`,
                });
            }
        }

        // "All slides" row — first in DOM order (= tab order, audit-r1 M7).
        const allRow = contentEl.createEl('div', { cls: 'ai-organiser-polish-allslides' });
        const allCb = allRow.createEl('input', { attr: { type: 'checkbox', id: 'ai-organiser-polish-all' } });
        this.allSlidesCheckboxEl = allCb;
        const allLabel = allRow.createEl('label', { cls: 'ai-organiser-polish-allslides-label', attr: { for: 'ai-organiser-polish-all' } });
        allLabel.createEl('span', { cls: 'ai-organiser-polish-allslides-title', text: this.t.allSlides });
        allLabel.createEl('span', { cls: 'ai-organiser-polish-allslides-desc', text: this.t.allSlidesDescription });
        this.cleanups.push(listen(allCb, 'change', () => {
            this.allSlidesChecked = allCb.checked;
            this.syncControls();
        }));

        // Per-slide rows.
        const rowsWrap = contentEl.createEl('div', { cls: 'ai-organiser-polish-rows' });
        this.deck.slides.forEach((slide, i) => {
            const row = rowsWrap.createEl('div', { cls: 'ai-organiser-polish-row' });
            const cbId = `ai-organiser-polish-row-${i}`;
            const cb = row.createEl('input', { attr: { type: 'checkbox', id: cbId } });
            const label = row.createEl('label', { cls: 'ai-organiser-polish-row-label', attr: { for: cbId } });
            label.setText(`${i + 1}. ${slide.title ?? ''}`);

            const ta = row.createEl('textarea', { cls: 'ai-organiser-polish-row-input' });
            ta.value = this.rowStates[i].instruction;
            ta.setAttribute('placeholder', this.t.rowInstructionPlaceholder);
            ta.setAttribute('aria-label', this.t.rowInstructionLabel
                .replace('{n}', String(i + 1))
                .replace('{title}', slide.title ?? ''));

            this.rowCheckboxEls.push(cb);
            this.rowTextareaEls.push(ta);

            this.cleanups.push(listen(cb, 'change', () => {
                this.rowStates[i].checked = cb.checked;
                this.syncControls();
            }));
            this.cleanups.push(listen(ta, 'input', () => {
                this.rowStates[i].instruction = ta.value;
            }));
        });

        // Error banner — built once, hidden until an error lands (role=alert
        // so screen readers announce it on transition into Error state).
        this.errorBannerEl = contentEl.createEl('div', {
            cls: 'ai-organiser-polish-error',
            attr: { role: 'alert' },
        });

        // Action row — Cancel (left) then Action (right). Action last in DOM
        // order so tab order ends on the primary affordance (audit-r1 M7).
        const actions = contentEl.createEl('div', { cls: 'ai-organiser-polish-actions' });
        const cancelBtn = actions.createEl('button', { cls: 'ai-organiser-polish-cancel', text: this.t.cancel });
        const actionBtn = actions.createEl('button', { cls: 'ai-organiser-polish-action mod-cta' });
        this.cancelBtnEl = cancelBtn;
        this.actionBtnEl = actionBtn;
        this.cleanups.push(listen(cancelBtn, 'click', () => this.close()));
        this.cleanups.push(listen(actionBtn, 'click', () => { void this.handleSubmit(); }));

        this.syncControls();
        this.renderErrorBanner();
    }

    onClose(): void {
        // Canonical close order (src/ui/modals/_conventions.md): abort async →
        // run cleanups → (no Component) → clear DOM. Plus our own contract:
        // notify the handler so it clears its single-flight record.
        this.abortController.abort();
        for (const fn of this.cleanups) fn();
        this.cleanups.length = 0;
        this.opts.onClose?.();
        this.contentEl.empty();
    }

    private async handleSubmit(): Promise<void> {
        if (this.submitting) return;
        const draft = this.buildDraft();
        if (!draft) return;
        this.setSubmittingState(true);
        this.errorMessage = null;
        this.renderErrorBanner();

        const outcome = await this.opts.onSubmit(draft, this.abortController.signal)
            .catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

        if (this.abortController.signal.aborted) return; // modal already closing
        if (outcome.ok) {
            this.close();
        } else {
            this.setSubmittingState(false);
            this.errorMessage = outcome.error;
            this.renderErrorBanner();
        }
    }

    private buildDraft(): PolishSubmit | null {
        if (this.allSlidesChecked) return { kind: 'all' };
        const selections = this.rowStates
            .map((s, i) => ({ slideIndex: i, instruction: s.instruction }))
            .filter((_, i) => this.rowStates[i].checked);
        if (selections.length === 0) return null;
        return { kind: 'selective', selections };
    }

    private setSubmittingState(submitting: boolean): void {
        this.submitting = submitting;
        this.syncControls();
    }

    /** Recompute disabled states + action-button label from current state. */
    private syncControls(): void {
        const allMode = this.allSlidesChecked;
        const n = this.rowStates.filter(s => s.checked).length;
        const rowsDisabled = this.submitting || allMode;

        for (const cb of this.rowCheckboxEls) this.setDisabled(cb, rowsDisabled);
        for (const ta of this.rowTextareaEls) this.setDisabled(ta, rowsDisabled);
        if (this.allSlidesCheckboxEl) this.setDisabled(this.allSlidesCheckboxEl, this.submitting);
        // Cancel always reachable so the user keeps a keyboard abort affordance
        // during Submitting (audit-r2 L1).
        if (this.cancelBtnEl) this.setDisabled(this.cancelBtnEl, false);

        if (this.actionBtnEl) {
            this.actionBtnEl.setText(
                this.submitting ? this.t.actionButtonSubmitting
                    : allMode ? this.t.actionButtonAll
                        : this.t.actionButton.replace('{n}', String(n)),
            );
            const actionDisabled = this.submitting ? true : (allMode ? false : n === 0);
            this.setDisabled(this.actionBtnEl, actionDisabled);
        }

        if (allMode) this.contentEl.addClass('is-all-mode');
        else this.contentEl.removeClass('is-all-mode');
    }

    private renderErrorBanner(): void {
        if (!this.errorBannerEl) return;
        this.errorBannerEl.setText(this.errorMessage ?? '');
        if (this.errorMessage) this.errorBannerEl.addClass('is-visible');
        else this.errorBannerEl.removeClass('is-visible');
    }

    private setDisabled(el: HTMLElement, disabled: boolean): void {
        (el as HTMLButtonElement).disabled = disabled;
        if (disabled) el.setAttribute('disabled', 'true');
        else el.removeAttribute('disabled');
    }
}

/** Format findings for one slide as plain text (one line per finding). Empty
 *  array → empty string (the modal renders the placeholder hint). */
export function formatFindingsForSlide(findings: readonly QualityFinding[], slideIndex: number): string {
    return findings
        .filter(f => f.slideIndex === slideIndex)
        .map(f => `[${f.severity}] ${f.issue} → ${f.suggestion}`)
        .join('\n');
}
