/**
 * Audio-attach presentational component (plan §4, R1 M3 + R3 H1).
 *
 * STRICT PRESENTATIONAL CONTRACT — no orchestration, no picker logic, no
 * service calls. The host (`MinutesCreationModal`, `TranscribeOnlyModal`)
 * supplies view state + intent callbacks; this component renders the
 * appropriate UI and forwards user clicks to the callbacks. The
 * `AudioAttachCoordinator` lives one layer above and owns all the
 * platform-aware orchestration.
 *
 * Per-state binding table (plan §7 R3 H1):
 *  - empty         → attach / pick / record + optional detected-prompt chip
 *  - picking       → all buttons disabled + "opening picker…" overlay
 *  - attached      → per-item chips with displayName + Replace + Transcribe
 *  - transcribing  → progress text + Abort
 *  - transcribed   → snippet + Replace + Re-transcribe
 *  - error         → message + Retry
 *
 * Why this is its own file: previously the audio section lived inside
 * `MinutesCreationModal.renderAudioTranscriptionSection()` (~70 LOC of inline
 * DOM construction). With `TranscribeOnlyModal` (F3) needing the same UX and
 * the new state machine adding behaviour, factoring into a renderer keeps both
 * hosts in sync.
 */

import { setIcon, setTooltip, type App } from 'obsidian';
import { listen } from '../utils/domUtils';
import type {
    AudioAttachItem,
    AudioAttachViewState,
} from './speakerReviewState';
import type { Translations } from '../../i18n/types';

/**
 * One detected-audio entry surfaced from the active note's `![[audio]]` embeds.
 * Distinct from `AudioAttachItem` because the user has NOT accepted these yet;
 * they live in a prompt chip until the user clicks "Use it" or "Ignore".
 */
export interface DetectedAudioPrompt {
    /** Best-effort display name for the chip — usually the filename */
    displayName: string;
    /** Count of detected audio files (only the COUNT is rendered in the chip text) */
    count: number;
}

export interface AudioAttachOptions {
    state: AudioAttachViewState;
    /** When set, renders a "Detected N audio files…" chip above the trio */
    detectedPrompt?: DetectedAudioPrompt;
    /** Hide the Record button (e.g. mobile environments without MediaRecorder) */
    allowRecord: boolean;
    /** Translations bundle — keys consumed live in `t.minutes` */
    t: Translations;

    // ============================ Intent callbacks ============================
    // Source acquisition
    onAttachIntent: () => void;
    onPickVaultIntent: () => void;
    onRecordIntent: () => void;
    // Detected-prompt
    onDetectedAccept: () => void;
    onDetectedDismiss: () => void;
    // Lifecycle (R3 H1)
    onReplaceIntent: () => void;
    onTranscribeIntent: () => void;
    onAbortIntent: () => void;
    onRetryIntent: () => void;
}

export interface AudioAttachHandle {
    /** Re-render with a new state. Returns this same handle for chaining. */
    rerender(state: AudioAttachViewState, detectedPrompt?: DetectedAudioPrompt): AudioAttachHandle;
    /** Detach all event listeners. Idempotent. */
    destroy(): void;
}

/**
 * Render the audio-attach UI into `container`. Returns a handle for re-renders
 * and disposal. The host is expected to push `handle.destroy` into its own
 * cleanups array so listeners are released on modal close.
 */
export function renderAudioAttach(
    container: HTMLElement,
    options: AudioAttachOptions
): AudioAttachHandle {
    const root = container.createDiv({ cls: 'ai-organiser-audio-attach-section' });
    const cleanups: Array<() => void> = [];

    let currentOptions = options;

    const draw = (): void => {
        // Release listeners from the previous render before clearing the DOM.
        flush(cleanups);
        root.empty();
        renderInto(root, currentOptions, cleanups);
    };

    draw();

    return {
        rerender(state: AudioAttachViewState, detectedPrompt?: DetectedAudioPrompt) {
            currentOptions = { ...currentOptions, state, detectedPrompt };
            draw();
            return this;
        },
        destroy() {
            flush(cleanups);
            root.empty();
        },
    };
}

// ============================================================================
// Internal rendering
// ============================================================================

function renderInto(
    root: HTMLElement,
    options: AudioAttachOptions,
    cleanups: Array<() => void>
): void {
    const t = options.t.minutes;

    // ---- Header ----
    const header = root.createDiv({ cls: 'ai-organiser-audio-attach-header' });
    const icon = header.createSpan({ cls: 'ai-organiser-audio-attach-header-icon' });
    setIcon(icon, 'mic');
    header.createSpan({
        cls: 'ai-organiser-audio-attach-header-label',
        text: t.audioSectionHeading || 'Audio',
    });

    const desc = root.createDiv({
        cls: 'ai-organiser-audio-attach-description',
        text: t.audioSectionDescription || 'Attach an audio file, pick one from your vault, or record now',
    });
    desc.toggleClass('ai-organiser-text-muted', true);

    // ---- Action trio ----
    const trio = root.createDiv({ cls: 'ai-organiser-audio-attach-trio' });
    const trioDisabled = options.state.kind === 'picking';

    cleanups.push(
        renderTrioButton(trio, 'paperclip', t.audioAttachFile || 'Attach file…', trioDisabled, options.onAttachIntent)
    );
    cleanups.push(
        renderTrioButton(trio, 'folder-open', t.audioPickVault || 'Pick from vault…', trioDisabled, options.onPickVaultIntent)
    );
    if (options.allowRecord) {
        cleanups.push(
            renderTrioButton(trio, 'mic', t.audioRecordNow || 'Record', trioDisabled, options.onRecordIntent)
        );
    }

    // ---- Detected-prompt chip (only when in `empty` state) ----
    if (options.state.kind === 'empty' && options.detectedPrompt) {
        renderDetectedPrompt(root, options, cleanups);
    }

    // ---- Picking overlay ----
    if (options.state.kind === 'picking') {
        root.createDiv({
            cls: 'ai-organiser-audio-attach-overlay',
            text: t.audioPickerOpening || 'Opening picker…',
        });
    }

    // ---- Items list (attached / transcribing / transcribed / error) ----
    if (
        options.state.kind === 'attached' ||
        options.state.kind === 'transcribing' ||
        options.state.kind === 'transcribed' ||
        options.state.kind === 'error'
    ) {
        const items = options.state.items;
        const activeIndex =
            options.state.kind === 'transcribing' ? options.state.activeIndex : -1;
        renderItems(root, items, activeIndex, options, cleanups);
    }

    // ---- Bottom-level error banner (whole-section failure, e.g. picker threw) ----
    if (options.state.kind === 'error') {
        const banner = root.createDiv({ cls: 'ai-organiser-audio-attach-error' });
        banner.createSpan({ text: options.state.message });
        const retry = banner.createEl('button', {
            cls: 'ai-organiser-audio-attach-retry',
            text: t.audioRetry || 'Retry',
        });
        cleanups.push(listen(retry, 'click', options.onRetryIntent));
    }
}

function renderTrioButton(
    container: HTMLElement,
    iconName: string,
    label: string,
    disabled: boolean,
    onClick: () => void
): () => void {
    const btn = container.createEl('button', {
        cls: 'ai-organiser-audio-attach-btn',
    });
    btn.disabled = disabled;
    const iconEl = btn.createSpan({ cls: 'ai-organiser-audio-attach-btn-icon' });
    setIcon(iconEl, iconName);
    btn.createSpan({ cls: 'ai-organiser-audio-attach-btn-label', text: label });
    return listen(btn, 'click', onClick);
}

function renderDetectedPrompt(
    root: HTMLElement,
    options: AudioAttachOptions,
    cleanups: Array<() => void>
): void {
    const prompt = options.detectedPrompt;
    if (!prompt) return;
    const t = options.t.minutes;

    const chip = root.createDiv({ cls: 'ai-organiser-audio-detected-prompt' });
    const iconEl = chip.createSpan({ cls: 'ai-organiser-audio-detected-icon' });
    setIcon(iconEl, 'sparkles');

    const text = prompt.count === 1
        ? t.audioDetectedPromptOne || 'Detected 1 audio file in this note'
        : (t.audioDetectedPromptMany || 'Detected {count} audio files in this note').replace(
              '{count}',
              String(prompt.count)
          );
    chip.createSpan({ text });

    const useIt = chip.createEl('button', {
        cls: 'ai-organiser-audio-detected-accept mod-cta',
        text: t.audioDetectedUseIt || 'Use it',
    });
    cleanups.push(listen(useIt, 'click', options.onDetectedAccept));

    const ignore = chip.createEl('button', {
        cls: 'ai-organiser-audio-detected-ignore',
        text: t.audioDetectedIgnore || 'Ignore',
    });
    cleanups.push(listen(ignore, 'click', options.onDetectedDismiss));
}

function renderItems(
    root: HTMLElement,
    items: AudioAttachItem[],
    activeIndex: number,
    options: AudioAttachOptions,
    cleanups: Array<() => void>
): void {
    const t = options.t.minutes;
    const list = root.createDiv({ cls: 'ai-organiser-audio-attach-items' });

    items.forEach((item, idx) => {
        const row = list.createDiv({ cls: 'ai-organiser-audio-attach-item' });

        // Per-item state badge
        const badge = row.createSpan({ cls: 'ai-organiser-audio-attach-item-badge' });
        const badgeText = describeItemState(item, t);
        badge.setText(badgeText);
        if (item.itemState === 'transcribing' || idx === activeIndex) {
            badge.addClass('is-active');
        }
        if (item.itemState === 'error') {
            badge.addClass('is-error');
            if (item.errorMessage) setTooltip(badge, item.errorMessage);
        }

        // Display name
        row.createSpan({
            cls: 'ai-organiser-audio-attach-item-name',
            text: item.displayName,
        });

        // Per-row controls
        const controls = row.createDiv({ cls: 'ai-organiser-audio-attach-item-controls' });
        renderItemControls(controls, item, idx === activeIndex, options, cleanups);
    });
}

function describeItemState(item: AudioAttachItem, t: Translations['minutes']): string {
    switch (item.itemState) {
        case 'transcribed':
            return t.audioItemTranscribed || 'Transcribed';
        case 'transcribing':
            return t.audioItemTranscribing || 'Transcribing…';
        case 'pending':
            return t.audioItemPending || 'Ready';
        case 'error':
            return t.audioItemError || 'Error';
    }
}

function renderItemControls(
    container: HTMLElement,
    item: AudioAttachItem,
    isActive: boolean,
    options: AudioAttachOptions,
    cleanups: Array<() => void>
): void {
    const t = options.t.minutes;

    // Abort surfaces ONLY for the currently-transcribing item.
    if (item.itemState === 'transcribing' && isActive) {
        const btn = container.createEl('button', {
            cls: 'ai-organiser-audio-attach-item-btn ai-organiser-audio-attach-abort mod-warning',
            text: t.audioAbort || 'Stop',
        });
        cleanups.push(listen(btn, 'click', options.onAbortIntent));
        return;
    }

    // Transcribe (pending) / Re-transcribe (transcribed)
    if (item.itemState === 'pending' || item.itemState === 'transcribed') {
        const btn = container.createEl('button', {
            cls: 'ai-organiser-audio-attach-item-btn',
            text:
                item.itemState === 'transcribed'
                    ? t.audioRetranscribe || 'Re-transcribe'
                    : t.transcribeButton || 'Transcribe',
        });
        cleanups.push(listen(btn, 'click', options.onTranscribeIntent));
    }

    // Replace is always available on non-active rows
    const replace = container.createEl('button', {
        cls: 'ai-organiser-audio-attach-item-btn',
        text: t.audioReplace || 'Replace',
    });
    cleanups.push(listen(replace, 'click', options.onReplaceIntent));
}

// ============================================================================
// Helpers
// ============================================================================

function flush(cleanups: Array<() => void>): void {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        try {
            cleanup?.();
        } catch {
            // Listener cleanup failures are best-effort; swallow to avoid
            // cascading the dispose loop.
        }
    }
}

// Re-export App so callers don't need a separate obsidian import alongside this module.
export type { App };
