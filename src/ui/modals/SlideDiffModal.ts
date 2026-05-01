/**
 * Slide Diff Modal
 *
 * Inline diff review shown after `refineHtmlScoped` returns and BEFORE the
 * iframe is updated. Renders the in-scope text diff and an expander listing
 * any out-of-scope drift the orchestrator's `classifyDiff` flagged on slides
 * the user did NOT ask to change. User accepts or rejects the whole change.
 *
 * Plan: docs/completed/slide-authoring-editing.md §"Diff modal"
 */

import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type {
    ScopedDiff, SlideDiff, StructuralIntegrity, EditMode,
} from '../../services/chat/presentationTypes';

export type SlideDiffAction = 'accept' | 'reject';

export interface SlideDiffModalOptions {
    scopeDiff: ScopedDiff;
    outOfScopeDrift: SlideDiff[];
    structuralIntegrity: StructuralIntegrity;
    /** Same-slide sibling drift outside the user's element scope (audit Item 3).
     *  Null for non-element scope or when element-paths integrity is broken. */
    siblingDrift?: SlideDiff | null;
    /** Number of subtree text-change locations (audit Item 2). The
     *  design-mode banner fires when this is > 0 AND editMode === 'design'. */
    textChangedLocations?: number;
    /** Edit mode in effect when the refine was issued. Required for the
     *  design-mode banner gate. */
    editMode?: EditMode;
    onAction: (action: SlideDiffAction) => void;
}

export class SlideDiffModal extends Modal {
    private actionFired = false;

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly options: SlideDiffModalOptions,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.unifiedChat;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-slide-diff-modal');

        contentEl.createEl('h2', { text: t.slideDiffTitle });

        // Scope summary chip — tells the user exactly what was meant to change
        const scopeLabel = describeScope(this.options.scopeDiff, t);
        contentEl.createDiv({
            cls: 'ai-organiser-pres-diff-scope',
            text: scopeLabel,
        });

        // Structural integrity banner — only shown when something other than
        // 'preserved' is reported. The orchestrator does NOT block on this;
        // the user gets a heads-up and can still accept (e.g. they actually
        // asked for a slide to be added).
        if (this.options.structuralIntegrity !== 'preserved') {
            const banner = contentEl.createDiv({ cls: 'ai-organiser-pres-diff-integrity-banner' });
            banner.textContent = describeIntegrity(this.options.structuralIntegrity, t);
        }

        // Design-mode-text-changed banner (audit Item 2 + Gemini-r5-G1):
        // Design mode promised the LLM only style changes — if normalized
        // text content drifted between old and new HTML, surface that as a
        // dedicated warning so the user catches LLM noncompliance.
        if (
            this.options.editMode === 'design'
            && (this.options.textChangedLocations ?? 0) > 0
            && t.slideDiffDesignTextChanged
        ) {
            const n = this.options.textChangedLocations ?? 0;
            const banner = contentEl.createDiv({
                cls: 'ai-organiser-pres-diff-design-changed-banner',
            });
            banner.textContent = t.slideDiffDesignTextChanged
                .replace('{n}', String(n))
                .replace('{s}', n === 1 ? '' : 's');
        }

        // In-scope text diff — the change the user asked for
        this.renderTextDiff(contentEl, this.options.scopeDiff.textDiff);

        // Sibling-drift expander (audit Item 3): same-slide changes the user
        // didn't scope to. Distinct from out-of-scope drift (which is
        // cross-slide). Only meaningful for element-scope refines.
        if (this.options.siblingDrift) {
            this.renderSiblingDrift(contentEl, this.options.siblingDrift, t);
        }

        // Empty-diff guard — if the LLM returned identical HTML, there is
        // nothing to apply. The Apply button stays disabled.
        const isEmpty = this.options.scopeDiff.textDiff.every(l => l.type === 'unchanged');

        // Out-of-scope drift expander — collapsed by default. Surface a
        // visible advisory above the action buttons so the user doesn't
        // accept without realising slides outside their scope changed.
        // (Persona walkthrough P1 finding — drift was easy to miss when
        // the expander stayed collapsed.)
        if (this.options.outOfScopeDrift.length > 0) {
            const n = this.options.outOfScopeDrift.length;
            const advisory = contentEl.createDiv({
                cls: 'ai-organiser-pres-diff-drift-advisory',
            });
            advisory.textContent = t.slideDiffDriftAdvisory
                .replace('{n}', String(n))
                .replace('{s}', n === 1 ? '' : 's');
            this.renderDriftExpander(contentEl, this.options.outOfScopeDrift, t);
        }

        // Action buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t.slideDiffReject)
                .setWarning()
                .onClick(() => this.fireAction('reject')))
            .addButton(btn => {
                btn.setButtonText(t.slideDiffAccept).setCta();
                if (isEmpty) btn.setDisabled(true);
                btn.onClick(() => this.fireAction('accept'));
                return btn;
            });

        if (isEmpty) {
            contentEl.createDiv({
                cls: 'ai-organiser-pres-diff-empty',
                text: t.slideDiffEmpty,
            });
        }
    }

    private renderTextDiff(parent: HTMLElement, textDiff: ScopedDiff['textDiff']): void {
        const container = parent.createDiv({ cls: 'ai-organiser-diff-container' });
        const pre = container.createEl('pre', { cls: 'ai-organiser-diff-pre' });
        const MAX_LINES = 500;
        const visible = textDiff.slice(0, MAX_LINES);
        for (const line of visible) {
            const lineEl = pre.createEl('div', {
                cls: `ai-organiser-diff-line ai-organiser-diff-line-${line.type}`,
            });
            const prefix = diffPrefix(line.type);
            lineEl.createSpan({ cls: 'ai-organiser-diff-prefix', text: prefix });
            lineEl.createSpan({ cls: 'ai-organiser-diff-content', text: line.content });
        }
        if (textDiff.length > MAX_LINES) {
            pre.createEl('div', {
                cls: 'ai-organiser-diff-line ai-organiser-diff-line-unchanged',
                text: `  … ${textDiff.length - MAX_LINES} more lines (accept to apply all)`,
            });
        }
    }

    private renderSiblingDrift(
        parent: HTMLElement,
        sibling: SlideDiff,
        t: import('../../i18n/types').Translations['modals']['unifiedChat'],
    ): void {
        const advisory = parent.createDiv({
            cls: 'ai-organiser-pres-diff-sibling-advisory',
        });
        if (t.slideDiffSiblingAdvisory) {
            const n = sibling.textDiff.filter(l => l.type !== 'unchanged').length;
            advisory.textContent = t.slideDiffSiblingAdvisory
                .replace('{n}', String(n))
                .replace('{s}', n === 1 ? '' : 's');
        }
        const details = parent.createEl('details', {
            cls: 'ai-organiser-pres-diff-sibling-drift',
        });
        const summary = details.createEl('summary');
        summary.textContent = t.slideDiffSiblingSummary
            ?? `Sibling changes — slide ${sibling.slideIndex + 1}`;
        this.renderTextDiff(details, sibling.textDiff);
    }

    private renderDriftExpander(
        parent: HTMLElement,
        drift: SlideDiff[],
        t: import('../../i18n/types').Translations['modals']['unifiedChat'],
    ): void {
        const details = parent.createEl('details', { cls: 'ai-organiser-pres-diff-drift' });
        const summary = details.createEl('summary');
        const plural = drift.length === 1 ? '' : 's';
        summary.textContent = t.slideDiffDriftSummary
            .replace('{n}', String(drift.length))
            .replace('{s}', plural);

        for (const d of drift) {
            const block = details.createDiv({ cls: 'ai-organiser-pres-diff-drift-block' });
            block.createEl('h4', { text: `Slide ${d.slideIndex + 1} — ${d.severity}` });
            this.renderTextDiff(block, d.textDiff);
        }
    }

    private fireAction(action: SlideDiffAction): void {
        this.actionFired = true;
        this.close();
        this.options.onAction(action);
    }

    onClose(): void {
        this.contentEl.empty();
        // ESC / X-close fires reject so the iframe never updates without
        // explicit user consent. Mirrors ReviewEditsModal's contract.
        if (!this.actionFired) {
            this.actionFired = true;
            this.options.onAction('reject');
        }
    }

    /** Test seam — drives the same path as a button click. */
    simulateAction(action: SlideDiffAction): void {
        this.fireAction(action);
    }

    /** Test seam — exposes the plugin reference (currently unused but
     *  available for future i18n migration). */
    getPlugin(): AIOrganiserPlugin {
        return this.plugin;
    }
}

function diffPrefix(type: 'added' | 'removed' | 'unchanged'): string {
    if (type === 'added') return '+';
    if (type === 'removed') return '−';
    return ' ';
}

function describeScope(
    diff: ScopedDiff,
    t: import('../../i18n/types').Translations['modals']['unifiedChat'],
): string {
    const s = diff.scope;
    if (s.kind === 'range') {
        const end = s.slideEndIndex ?? s.slideIndex;
        return t.slideSelectionLabelRange
            .replace('{n}', String(s.slideIndex + 1))
            .replace('{end}', String(end + 1));
    }
    if (s.kind === 'slide') {
        return t.slideSelectionLabelSlide.replace('{n}', String(s.slideIndex + 1));
    }
    const kind = s.elementKind ?? 'element';
    return t.slideSelectionLabelElement
        .replace('{n}', String(s.slideIndex + 1))
        .replace('{kind}', kind);
}

function describeIntegrity(
    integrity: StructuralIntegrity,
    t: import('../../i18n/types').Translations['modals']['unifiedChat'],
): string {
    switch (integrity) {
        case 'slides-added':           return t.slideDiffIntegrityAdded;
        case 'slides-removed':         return t.slideDiffIntegrityRemoved;
        case 'class-changed':          return t.slideDiffIntegrityClassChanged;
        case 'element-paths-changed':  return t.slideDiffIntegrityElementPathsChanged ?? '';
        case 'preserved':              return '';
    }
}
