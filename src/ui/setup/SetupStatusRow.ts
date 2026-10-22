/**
 * SetupStatusRow: the one row at the top of a feature's settings section.
 * Shows `Not set up`, `Ready` or `Needs attention` (with the reason) plus a single
 * "Set up" / "Review setup" button. The state is computed by `evaluateSetup`; this file
 * only renders it.
 */
import { Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { SetupEvaluation, SetupState } from '../../core/setupState';

/** Plain text for a state. Exported so tests and other surfaces use the same words. */
export function statusLabel(t: Translations, state: SetupState): string {
    switch (state) {
        case 'ready': return t.setup.statusReady;
        case 'needs-attention': return t.setup.statusNeedsAttention;
        default: return t.setup.statusNotSetUp;
    }
}

/** Status text with the reason appended when there is one. */
export function statusText(t: Translations, evaluation: SetupEvaluation): string {
    const base = statusLabel(t, evaluation.state);
    if (evaluation.state === 'ready' || !evaluation.reason) return base;
    return `${base}: ${t.setup.reasons[evaluation.reason]}`;
}

export interface SetupStatusRowOptions {
    container: HTMLElement;
    t: Translations;
    /** The feature's name, shown as the row title. */
    name: string;
    evaluation: SetupEvaluation;
    onOpen: () => void;
}

/** Render the status row and return the Setting for further tweaks. */
export function renderSetupStatusRow(opts: SetupStatusRowOptions): Setting {
    const { container, t, name, evaluation, onOpen } = opts;
    const setting = new Setting(container).setName(name).setDesc(statusText(t, evaluation));
    setting.settingEl.addClass('ai-organiser-setup-status');
    setting.settingEl.addClass(`ai-organiser-setup-status-${evaluation.state}`);
    setting.addButton((btn) => {
        const label = evaluation.state === 'ready' ? t.setup.reviewSetupButton : t.setup.setUpButton;
        btn.setButtonText(label).onClick(onOpen);
        btn.buttonEl.setAttribute('aria-label', `${label}: ${name}`);
        if (evaluation.state !== 'ready') btn.setCta();
    });
    return setting;
}
