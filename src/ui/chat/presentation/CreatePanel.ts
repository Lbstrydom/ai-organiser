/**
 * Create Panel — Slide creation chat-input accessory
 *
 * Pure renderer for the create-flow accessory. Subscribes to the
 * `CreationSourceController` for source state changes; lifts audience /
 * length / speed config out of the parent handler via callbacks.
 *
 * The panel handles its own `ChangeReason` routing (audit Gemini-r5-G4 +
 * r7-G3): status/label changes update a row in place; add/remove/reorder/
 * redetect/reset rebuild the source list. The handler stays decoupled —
 * it owns lifecycle (instantiate/dispose), the panel owns its DOM.
 *
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase C).
 */

import type { App } from 'obsidian';
import type AIOrganiserPlugin from '../../../main';
import type { Translations } from '../../../i18n/types';
import type {
    AudienceTier, ModelTier, CreationConfig,
    CreationSourceState, SourceFailureCode, SelectedSource,
} from '../../../services/chat/presentationTypes';
import type {
    CreationSourceController, SourceChangeReason,
} from '../../../services/chat/creationSourceController';
import { openSourcePicker } from '../../modals/SourcePickerModal';

/** Subset of i18n strings the panel consumes. */
export type CreatePanelT = Pick<
    Translations['modals']['unifiedChat'],
    | 'slideCreateAudienceLabel' | 'slideCreateAudienceAnalyst'
    | 'slideCreateAudienceExecutive' | 'slideCreateAudienceGeneral'
    | 'slideCreateLengthLabel' | 'slideCreateLengthCustom'
    | 'slideCreateSpeedLabel' | 'slideCreateSpeedFast' | 'slideCreateSpeedQuality'
    | 'slideCreateSourcesLabel'
    | 'slideCreateSourcesAddNote' | 'slideCreateSourcesAddWeb' | 'slideCreateSourcesAddFolder'
    | 'slideCreateSourcesAutoDetected' | 'slideCreateSourcesEmpty'
    | 'slideCreateSourceRemove' | 'slideCreateRedetectActive'
    | 'slideCreateValidationZeroSources' | 'slideCreateValidationZeroLength'
    | 'slideCreateValidationLengthOutOfRange'
    | 'slideCreateBlockNoUsableSources' | 'slideCreatePartialFailureNotice'
    | 'slideCreateSourceFailureNoteNotFound' | 'slideCreateSourceFailureNoteEmpty'
    | 'slideCreateSourceFailureNoteReadFailed'
    | 'slideCreateSourceFailureFolderNotFound' | 'slideCreateSourceFailureFolderEmpty'
    | 'slideCreateSourceFailureWebSearchFailed' | 'slideCreateSourceFailureWebSearchNoResults'
>;

export interface CreatePanelOptions {
    app: App;
    plugin: AIOrganiserPlugin;
    controller: CreationSourceController;
    t: CreatePanelT;
    /** Current config — panel reads but does NOT own. Mutations go through onConfigChange. */
    getConfig: () => CreationConfig;
    onConfigChange: (next: CreationConfig) => void;
    /** Optional: panel can fire validation errors as user adjusts inputs. */
    onValidationChange?: (error: string | null) => void;
}

interface PanelState {
    /** Per-row DOM handles, keyed by SelectedSource (parallel to controller snapshot). */
    rowEls: HTMLElement[];
    sourcesListEl: HTMLElement | null;
    redetectBtn: HTMLElement | null;
    validationEl: HTMLElement | null;
    unsubscribe: (() => void) | null;
}

const LENGTH_PRESETS: ReadonlyArray<number> = [5, 8, 12];
const MAX_LENGTH = 50;
const MIN_LENGTH = 1;

/**
 * Mount or remount the create panel inside `container`. Idempotent — safe
 * to call repeatedly; the panel disposes its prior subscription before
 * resubscribing. Returns a dispose function the handler must call when
 * the panel is being torn down (mode switch, modal close, etc.).
 */
export function renderCreatePanel(
    container: HTMLElement,
    opts: CreatePanelOptions,
): () => void {
    container.empty();
    container.addClass('ai-organiser-pres-create-panel');

    const state: PanelState = {
        rowEls: [],
        sourcesListEl: null,
        redetectBtn: null,
        validationEl: null,
        unsubscribe: null,
    };

    renderAudienceRow(container, opts);
    renderLengthRow(container, opts);
    renderSpeedRow(container, opts);
    renderSourcesSection(container, opts, state);
    state.validationEl = renderValidationRow(container);

    runValidation(opts, state);

    state.unsubscribe = opts.controller.subscribe((reason) => {
        handleChange(reason, opts, state);
    });

    return () => {
        if (state.unsubscribe) {
            state.unsubscribe();
            state.unsubscribe = null;
        }
    };
}

// ── Audience ────────────────────────────────────────────────────────────────

function renderAudienceRow(parent: HTMLElement, opts: CreatePanelOptions): void {
    const row = parent.createDiv({
        cls: 'ai-organiser-pres-create-row',
        attr: { role: 'radiogroup', 'aria-label': opts.t.slideCreateAudienceLabel },
    });
    row.createSpan({ cls: 'ai-organiser-pres-create-row-label', text: opts.t.slideCreateAudienceLabel });

    addAudiencePill(row, opts, 'analyst', opts.t.slideCreateAudienceAnalyst);
    addAudiencePill(row, opts, 'executive', opts.t.slideCreateAudienceExecutive);
    addAudiencePill(row, opts, 'general', opts.t.slideCreateAudienceGeneral);
}

function addAudiencePill(
    row: HTMLElement,
    opts: CreatePanelOptions,
    audience: AudienceTier,
    label: string,
): void {
    const isActive = opts.getConfig().audience === audience;
    const pill = row.createEl('button', {
        cls: `ai-organiser-pres-create-pill${isActive ? ' is-active' : ''}`,
        text: label,
        attr: {
            type: 'button',
            role: 'radio',
            'aria-checked': isActive ? 'true' : 'false',
            tabindex: isActive ? '0' : '-1',
        },
    });
    pill.addEventListener('click', () => {
        const cfg = opts.getConfig();
        if (cfg.audience === audience) return;
        opts.onConfigChange({ ...cfg, audience });
        // Toggle active class on all siblings.
        for (const sib of Array.from(row.querySelectorAll('.ai-organiser-pres-create-pill'))) {
            sib.removeClass('is-active');
            sib.setAttribute('aria-checked', 'false');
            sib.setAttribute('tabindex', '-1');
        }
        pill.addClass('is-active');
        pill.setAttribute('aria-checked', 'true');
        pill.setAttribute('tabindex', '0');
    });
}

// ── Length ──────────────────────────────────────────────────────────────────

function renderLengthRow(parent: HTMLElement, opts: CreatePanelOptions): void {
    const row = parent.createDiv({ cls: 'ai-organiser-pres-create-row' });
    row.createSpan({ cls: 'ai-organiser-pres-create-row-label', text: opts.t.slideCreateLengthLabel });

    const presetGroup = row.createDiv({
        cls: 'ai-organiser-pres-create-pill-group',
        attr: { role: 'radiogroup', 'aria-label': opts.t.slideCreateLengthLabel },
    });
    for (const n of LENGTH_PRESETS) {
        addLengthPill(presetGroup, opts, n);
    }
    // Custom numeric input
    const customInput = row.createEl('input', {
        type: 'number',
        cls: 'ai-organiser-pres-create-length-input',
        attr: {
            min: String(MIN_LENGTH),
            max: String(MAX_LENGTH),
            step: '1',
            'aria-label': opts.t.slideCreateLengthCustom,
        },
    });
    customInput.value = String(opts.getConfig().length);
    customInput.addEventListener('change', () => {
        const raw = parseInt(customInput.value, 10);
        if (!Number.isFinite(raw)) return;
        const clamped = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, raw));
        customInput.value = String(clamped);
        opts.onConfigChange({ ...opts.getConfig(), length: clamped });
        // Refresh active pill class.
        for (const pill of Array.from(presetGroup.querySelectorAll('.ai-organiser-pres-create-pill'))) {
            const presetN = Number(pill.getAttribute('data-preset'));
            const active = presetN === clamped;
            pill.toggleClass('is-active', active);
            pill.setAttribute('aria-checked', active ? 'true' : 'false');
            pill.setAttribute('tabindex', active ? '0' : '-1');
        }
    });
}

function addLengthPill(group: HTMLElement, opts: CreatePanelOptions, n: number): void {
    const isActive = opts.getConfig().length === n;
    const pill = group.createEl('button', {
        cls: `ai-organiser-pres-create-pill${isActive ? ' is-active' : ''}`,
        text: String(n),
        attr: {
            type: 'button',
            role: 'radio',
            'data-preset': String(n),
            'aria-checked': isActive ? 'true' : 'false',
            tabindex: isActive ? '0' : '-1',
        },
    });
    pill.addEventListener('click', () => {
        const cfg = opts.getConfig();
        if (cfg.length === n) return;
        opts.onConfigChange({ ...cfg, length: n });
        for (const sib of Array.from(group.querySelectorAll('.ai-organiser-pres-create-pill'))) {
            sib.removeClass('is-active');
            sib.setAttribute('aria-checked', 'false');
            sib.setAttribute('tabindex', '-1');
        }
        pill.addClass('is-active');
        pill.setAttribute('aria-checked', 'true');
        pill.setAttribute('tabindex', '0');
        // Sync custom input.
        const input = group.parentElement?.querySelector<HTMLInputElement>('.ai-organiser-pres-create-length-input');
        if (input) input.value = String(n);
    });
}

// ── Speed ───────────────────────────────────────────────────────────────────

function renderSpeedRow(parent: HTMLElement, opts: CreatePanelOptions): void {
    const row = parent.createDiv({
        cls: 'ai-organiser-pres-create-row',
        attr: { role: 'radiogroup', 'aria-label': opts.t.slideCreateSpeedLabel },
    });
    row.createSpan({ cls: 'ai-organiser-pres-create-row-label', text: opts.t.slideCreateSpeedLabel });

    addSpeedPill(row, opts, 'fast', opts.t.slideCreateSpeedFast);
    addSpeedPill(row, opts, 'quality', opts.t.slideCreateSpeedQuality);
}

function addSpeedPill(
    row: HTMLElement,
    opts: CreatePanelOptions,
    tier: ModelTier,
    label: string,
): void {
    const isActive = opts.getConfig().speedTier === tier;
    const pill = row.createEl('button', {
        cls: `ai-organiser-pres-create-pill${isActive ? ' is-active' : ''}`,
        text: label,
        attr: {
            type: 'button',
            role: 'radio',
            'aria-checked': isActive ? 'true' : 'false',
            tabindex: isActive ? '0' : '-1',
        },
    });
    pill.addEventListener('click', () => {
        const cfg = opts.getConfig();
        if (cfg.speedTier === tier) return;
        opts.onConfigChange({ ...cfg, speedTier: tier });
        for (const sib of Array.from(row.querySelectorAll('.ai-organiser-pres-create-pill'))) {
            sib.removeClass('is-active');
            sib.setAttribute('aria-checked', 'false');
            sib.setAttribute('tabindex', '-1');
        }
        pill.addClass('is-active');
        pill.setAttribute('aria-checked', 'true');
        pill.setAttribute('tabindex', '0');
    });
}

// ── Sources ─────────────────────────────────────────────────────────────────

function renderSourcesSection(
    parent: HTMLElement,
    opts: CreatePanelOptions,
    state: PanelState,
): void {
    const section = parent.createDiv({ cls: 'ai-organiser-pres-create-sources' });

    const header = section.createDiv({ cls: 'ai-organiser-pres-create-sources-header' });
    header.createSpan({
        cls: 'ai-organiser-pres-create-row-label',
        text: opts.t.slideCreateSourcesLabel,
    });
    state.redetectBtn = renderRedetectButton(header, opts);

    state.sourcesListEl = section.createDiv({ cls: 'ai-organiser-pres-create-sources-list' });
    rebuildSourcesList(opts, state);

    const buttons = section.createDiv({ cls: 'ai-organiser-pres-create-sources-actions' });
    addSourceButton(buttons, opts, 'note', opts.t.slideCreateSourcesAddNote);
    addSourceButton(buttons, opts, 'web', opts.t.slideCreateSourcesAddWeb);
    addSourceButton(buttons, opts, 'folder', opts.t.slideCreateSourcesAddFolder);
}

function renderRedetectButton(parent: HTMLElement, opts: CreatePanelOptions): HTMLElement {
    const btn = parent.createEl('button', {
        cls: 'ai-organiser-pres-create-redetect',
        text: opts.t.slideCreateRedetectActive,
        attr: { type: 'button' },
    });
    btn.addEventListener('click', () => {
        opts.controller.redetectActive();
    });
    syncRedetectVisibility(btn, opts);
    return btn;
}

function syncRedetectVisibility(btn: HTMLElement, opts: CreatePanelOptions): void {
    const stale = opts.controller.getSnapshot().autoDetectedStale;
    btn.toggleClass('is-hidden', !stale);
}

function rebuildSourcesList(opts: CreatePanelOptions, state: PanelState): void {
    if (!state.sourcesListEl) return;
    state.sourcesListEl.empty();
    state.rowEls = [];

    const snap = opts.controller.getSnapshot();
    if (snap.states.length === 0) {
        state.sourcesListEl.createDiv({
            cls: 'ai-organiser-pres-create-sources-empty',
            text: opts.t.slideCreateSourcesEmpty,
        });
        return;
    }

    for (let i = 0; i < snap.states.length; i++) {
        const rowEl = renderSourceRow(state.sourcesListEl, opts, snap.states[i], i);
        state.rowEls.push(rowEl);
    }
}

function renderSourceRow(
    parent: HTMLElement,
    opts: CreatePanelOptions,
    s: CreationSourceState,
    index: number,
): HTMLElement {
    const row = parent.createDiv({ cls: 'ai-organiser-pres-create-source-row' });
    row.setAttribute('data-status', s.status);

    const kindIcon = row.createSpan({ cls: 'ai-organiser-pres-create-source-kind' });
    kindIcon.textContent = kindIconChar(s.selected.kind);

    const label = row.createSpan({ cls: 'ai-organiser-pres-create-source-label' });
    label.textContent = describeSource(s, opts.t);

    const status = row.createSpan({ cls: 'ai-organiser-pres-create-source-status' });
    setStatusContent(status, s, opts.t);

    const removeBtn = row.createEl('button', {
        cls: 'ai-organiser-pres-create-source-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': opts.t.slideCreateSourceRemove },
    });
    removeBtn.addEventListener('click', () => {
        opts.controller.removeSource(index);
    });

    return row;
}

function kindIconChar(kind: SelectedSource['kind']): string {
    if (kind === 'note') return '📄';
    if (kind === 'folder') return '📁';
    return '🔍';
}

function describeSource(s: CreationSourceState, t: CreatePanelT): string {
    const sel = s.selected;
    if (sel.autoDetected && sel.kind === 'note') {
        return `${sel.ref} ${t.slideCreateSourcesAutoDetected}`;
    }
    if (s.displayLabel) return s.displayLabel;
    return sel.ref;
}

function setStatusContent(
    el: HTMLElement,
    s: CreationSourceState,
    t: CreatePanelT,
): void {
    el.empty();
    el.removeClass('is-loading', 'is-resolved', 'is-error');
    if (s.status === 'loading') {
        el.addClass('is-loading');
        el.textContent = '⏳';
    } else if (s.status === 'resolved') {
        el.addClass('is-resolved');
        el.textContent = '✓';
    } else if (s.status === 'error') {
        el.addClass('is-error');
        el.textContent = '⚠';
        const failureMsg = describeFailure(s.failureCode, s.selected, t);
        if (failureMsg) el.setAttribute('title', failureMsg);
    } else {
        el.textContent = '';
    }
}

function describeFailure(
    code: SourceFailureCode | undefined,
    selected: SelectedSource,
    t: CreatePanelT,
): string | null {
    if (!code) return null;
    const ref = selected.ref;
    switch (code) {
        case 'note-not-found':         return t.slideCreateSourceFailureNoteNotFound.replace('{ref}', ref);
        case 'note-empty':             return t.slideCreateSourceFailureNoteEmpty.replace('{ref}', ref);
        case 'note-read-failed':       return t.slideCreateSourceFailureNoteReadFailed.replace('{ref}', ref);
        case 'folder-not-found':       return t.slideCreateSourceFailureFolderNotFound.replace('{ref}', ref);
        case 'folder-empty':           return t.slideCreateSourceFailureFolderEmpty.replace('{ref}', ref);
        case 'web-search-failed':      return t.slideCreateSourceFailureWebSearchFailed.replace('{query}', ref);
        case 'web-search-no-results':  return t.slideCreateSourceFailureWebSearchNoResults.replace('{query}', ref);
        case 'unsupported-kind':       return null;
    }
    return null;
}

function addSourceButton(
    parent: HTMLElement,
    opts: CreatePanelOptions,
    kind: 'note' | 'web' | 'folder',
    label: string,
): void {
    const btn = parent.createEl('button', {
        cls: 'ai-organiser-pres-create-source-add',
        text: label,
        attr: { type: 'button' },
    });
    btn.addEventListener('click', () => {
        openSourcePicker(opts.app, opts.plugin, kind, (selected) => {
            if (!selected) return;
            opts.controller.addSource(selected);
            // Eagerly preload the freshly-added source — gives the user
            // fast visual feedback (web-search may take seconds).
            const idx = opts.controller.getSnapshot().selected.length - 1;
            void opts.controller.preloadAsync(idx);
        });
    });
}

// ── Validation ──────────────────────────────────────────────────────────────

function renderValidationRow(parent: HTMLElement): HTMLElement {
    const el = parent.createDiv({
        cls: 'ai-organiser-pres-create-validation',
        attr: { role: 'status', 'aria-live': 'polite' },
    });
    el.toggleClass('is-hidden', true);
    return el;
}

function runValidation(opts: CreatePanelOptions, state: PanelState): void {
    if (!state.validationEl) return;
    const cfg = opts.getConfig();
    const snap = opts.controller.getSnapshot();
    let msg: string | null = null;
    if (snap.selected.length === 0) {
        msg = opts.t.slideCreateValidationZeroSources;
    } else if (!Number.isFinite(cfg.length) || cfg.length <= 0) {
        msg = opts.t.slideCreateValidationZeroLength;
    } else if (cfg.length < MIN_LENGTH || cfg.length > MAX_LENGTH) {
        msg = opts.t.slideCreateValidationLengthOutOfRange;
    } else {
        // Surface partial-failure notice when ≥1 source resolved but ≥1 failed.
        const failedCount = snap.states.filter(s => s.status === 'error').length;
        const resolvedCount = snap.states.filter(s => s.status === 'resolved').length;
        if (failedCount > 0 && resolvedCount === 0) {
            // All known statuses are errors — block.
            const allErrored = snap.states.every(s => s.status === 'error');
            if (allErrored) msg = opts.t.slideCreateBlockNoUsableSources;
        } else if (failedCount > 0 && resolvedCount > 0) {
            msg = opts.t.slideCreatePartialFailureNotice
                .replace('{n}', String(failedCount))
                .replace('{s}', failedCount === 1 ? '' : 's');
        }
    }
    state.validationEl.toggleClass('is-hidden', !msg);
    state.validationEl.textContent = msg ?? '';
    if (opts.onValidationChange) opts.onValidationChange(msg);
}

// ── Subscription dispatch (audit Gemini-r5-G4 + r7-G3) ──────────────────────

function handleChange(
    reason: SourceChangeReason,
    opts: CreatePanelOptions,
    state: PanelState,
): void {
    if (reason === 'add' || reason === 'remove' || reason === 'reorder' || reason === 'reset') {
        rebuildSourcesList(opts, state);
        if (state.redetectBtn) syncRedetectVisibility(state.redetectBtn, opts);
        runValidation(opts, state);
        return;
    }
    if (reason === 'redetect') {
        rebuildSourcesList(opts, state);
        if (state.redetectBtn) syncRedetectVisibility(state.redetectBtn, opts);
        runValidation(opts, state);
        return;
    }
    if (reason === 'status') {
        // In-place row update — preserves focus and avoids list-wide flicker.
        const snap = opts.controller.getSnapshot();
        for (let i = 0; i < snap.states.length && i < state.rowEls.length; i++) {
            updateRowInPlace(state.rowEls[i], snap.states[i], opts.t);
        }
        if (state.redetectBtn) syncRedetectVisibility(state.redetectBtn, opts);
        runValidation(opts, state);
        return;
    }
}

function updateRowInPlace(
    rowEl: HTMLElement,
    s: CreationSourceState,
    t: CreatePanelT,
): void {
    rowEl.setAttribute('data-status', s.status);
    const labelEl = rowEl.querySelector<HTMLElement>('.ai-organiser-pres-create-source-label');
    if (labelEl) labelEl.textContent = describeSource(s, t);
    const statusEl = rowEl.querySelector<HTMLElement>('.ai-organiser-pres-create-source-status');
    if (statusEl) setStatusContent(statusEl, s, t);
}
