/**
 * Speaker review presentational component (plan §3 wireframe, F2b).
 *
 * Renders one row per detected speaker with:
 *   - 5-second audio preview from the FIRST utterance's real timestamp
 *     (suppressed when timestampSource === 'none', per R1 H2)
 *   - Rename input (free text + participant dropdown) with fuzzy datalist
 *   - "Same as…" merge dropdown
 *   - Per-row occurrence-count badge
 *   - Page-level Confirm / Skip CTAs
 *   - Degraded-state banner when labelSpeakers failed / detection unavailable
 *
 * STRICT PRESENTATIONAL — host supplies state + intent callbacks; this
 * component never calls services, never owns lifecycle of the
 * AudioPreviewHandle (host coordinator does that). Mirrors the
 * AudioAttachHelper boundary (R1 M3 / R3 M1).
 */

import { setIcon, setTooltip } from 'obsidian';
import { listen } from '../utils/domUtils';
import type {
    DetectedSpeaker,
    SpeakerMapping,
    SpeakerReviewState,
} from './speakerReviewState';
import type { AudioPreviewHandle } from '../coordinators/AudioPreviewSource';
import type { Translations } from '../../i18n/types';

export interface SpeakerReviewOptions {
    state: SpeakerReviewState;
    /**
     * Names known from the meeting's participants field — used as dropdown
     * suggestions. Order preserved.
     */
    participants: string[];
    /**
     * Preview-audio handle owned by the host AudioAttachCoordinator. When
     * `null`, audio preview is suppressed entirely (consistent with the
     * `timestampSource === 'none'` policy). The panel never calls dispose
     * on this handle — that's the host's job.
     */
    preview: AudioPreviewHandle | null;
    /** Tells the panel whether to render preview buttons. False when timestamps unavailable. */
    timestampsAvailable: boolean;
    t: Translations;
    onConfirm: (mapping: SpeakerMapping) => void;
    onSkip: () => void;
    /**
     * Optional — when set, the panel renders an "Edit" button on the
     * `confirmed` state that lets the user re-open the review without
     * regenerating speakers. The host wires it to flip state back to
     * `pending`.
     */
    onEditAfterConfirm?: () => void;
}

export interface SpeakerReviewHandle {
    rerender(state: SpeakerReviewState, preview: AudioPreviewHandle | null): SpeakerReviewHandle;
    destroy(): void;
}

const PREVIEW_DURATION_SECONDS = 5;

/**
 * Render the panel into `container`. Returns a handle the host pushes into
 * its cleanups[]. `destroy()` is idempotent.
 */
export function renderSpeakerReview(
    container: HTMLElement,
    options: SpeakerReviewOptions
): SpeakerReviewHandle {
    const root = container.createDiv({ cls: 'ai-organiser-speaker-review-panel' });
    const cleanups: Array<() => void> = [];
    // Mapping captured per render — survives across button clicks WITHIN a
    // render, reset on rerender(). For the `confirmed` state we seed from
    // the existing mapping so the user sees their previous answers.
    let workingMapping: SpeakerMapping = seedMapping(options.state);

    let currentOptions = options;

    const draw = (): void => {
        flushCleanups(cleanups);
        root.empty();
        // Pass a getter (not a snapshot) so the Confirm handler reads the
        // CURRENT workingMapping at click time. Passing the value directly
        // would shadow the outer `let` via the parameter and the inner
        // closure would read stale state.
        renderInto(root, currentOptions, () => workingMapping, cleanups, (name) => {
            return (value: string): void => {
                workingMapping = { ...workingMapping, [name]: value };
            };
        });
    };

    draw();

    return {
        rerender(state: SpeakerReviewState, preview: AudioPreviewHandle | null) {
            currentOptions = { ...currentOptions, state, preview };
            workingMapping = seedMapping(state);
            draw();
            return this;
        },
        destroy() {
            flushCleanups(cleanups);
            root.empty();
        },
    };
}

// ============================================================================
// Rendering
// ============================================================================

function renderInto(
    root: HTMLElement,
    options: SpeakerReviewOptions,
    getWorkingMapping: () => SpeakerMapping,
    cleanups: Array<() => void>,
    makeUpdater: (label: string) => (value: string) => void
): void {
    const tMin = options.t.minutes;

    // not-required → render nothing; host should also hide the container.
    if (options.state.kind === 'not-required') return;

    // ---- Header ----
    const header = root.createDiv({ cls: 'ai-organiser-speaker-review-header' });
    const headerIcon = header.createSpan({ cls: 'ai-organiser-speaker-review-icon' });
    setIcon(headerIcon, 'users');
    header.createSpan({
        cls: 'ai-organiser-speaker-review-title',
        text: tMin.speakerReviewHeading || 'Confirm speakers',
    });

    // ---- Degraded-state banners ----
    if (options.state.kind === 'failed') {
        const banner = root.createDiv({ cls: 'ai-organiser-speaker-review-banner is-failed' });
        banner.setText(tMin.speakerLabellingThrewBanner || 'Speaker labelling could not run — proceeding without speaker labels');
        return;
    }
    if (options.state.kind === 'skipped') {
        // user-skip is silent — no banner created. Conscious skip; the user
        // already knows what they did. Other reasons get an explanatory banner.
        if (options.state.reason === 'user-skip') return;
        const banner = root.createDiv({ cls: 'ai-organiser-speaker-review-banner is-skipped' });
        if (options.state.reason === 'detection-failed') {
            banner.setText(tMin.speakerDetectionFailedBanner || 'Speaker detection failed — minutes will use semantic owner inference only');
        } else if (options.state.reason === 'detection-unavailable') {
            banner.setText(tMin.speakerDetectionUnavailableBanner || 'Audio timestamps unavailable — speaker preview disabled; minutes will proceed without speaker confirmation');
        }
        return;
    }

    // From here on the state is either `pending` (review needed) or
    // `confirmed` (review already done, but user can edit). Both have
    // `detected: DetectedSpeaker[]` and we render the row list.
    const detected: DetectedSpeaker[] = options.state.detected;

    // ---- Description ----
    const desc = root.createDiv({ cls: 'ai-organiser-speaker-review-description' });
    if (detected.length === 1) {
        desc.setText(tMin.speakerReviewSinglePersonHint || 'Only one speaker detected — no review needed');
    } else {
        const tpl = tMin.speakerReviewDescription || 'Detected {count} speakers — confirm or rename below before generating minutes';
        desc.setText(tpl.replace('{count}', String(detected.length)));
    }
    desc.addClass('ai-organiser-text-muted');

    // ---- Row list ----
    const list = root.createDiv({ cls: 'ai-organiser-speaker-review-rows' });
    // Seed each row with the CURRENT working mapping (read once at render time);
    // live updates flow back through makeUpdater(label) into the outer let.
    const seed = getWorkingMapping();
    for (const speaker of detected) {
        renderRow(list, speaker, options, seed, cleanups, makeUpdater(speaker.label));
    }

    // ---- Actions ----
    if (options.state.kind === 'pending') {
        renderPendingActions(root, options, getWorkingMapping, cleanups);
    } else if (options.state.kind === 'confirmed' && options.onEditAfterConfirm) {
        const actions = root.createDiv({ cls: 'ai-organiser-speaker-review-actions' });
        const editBtn = actions.createEl('button', {
            cls: 'ai-organiser-speaker-review-edit',
            text: tMin.speakerEditAfterConfirm || 'Edit',
        });
        cleanups.push(listen(editBtn, 'click', () => options.onEditAfterConfirm?.()));
    }
}

function renderRow(
    container: HTMLElement,
    speaker: DetectedSpeaker,
    options: SpeakerReviewOptions,
    workingMapping: SpeakerMapping,
    cleanups: Array<() => void>,
    onChange: (value: string) => void
): void {
    const tMin = options.t.minutes;
    const row = container.createDiv({ cls: 'ai-organiser-speaker-review-row' });
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `Speaker ${speaker.label}`);
    row.setAttribute('data-testid', 'speaker-row');

    // Label badge + occurrence count
    const labelBadge = row.createDiv({ cls: 'ai-organiser-speaker-review-label' });
    labelBadge.createSpan({ cls: 'ai-organiser-speaker-review-label-text', text: speaker.label });
    if (speaker.occurrenceCount > 0) {
        const occTpl = tMin.speakerOccurrenceCountLabel || '{count} segments';
        labelBadge.createSpan({
            cls: 'ai-organiser-speaker-review-occurrence',
            text: occTpl.replace('{count}', String(speaker.occurrenceCount)),
        });
    }

    // Preview + snippet
    const previewRow = row.createDiv({ cls: 'ai-organiser-speaker-review-preview' });
    renderPreviewControl(previewRow, speaker, options, cleanups);
    previewRow.createSpan({
        cls: 'ai-organiser-speaker-review-snippet',
        text: speaker.firstUtteranceText.slice(0, 120),
    });

    // Rename input row
    const renameRow = row.createDiv({ cls: 'ai-organiser-speaker-review-rename' });
    const labelEl = renameRow.createEl('label', {
        cls: 'ai-organiser-speaker-review-rename-label',
        text: tMin.speakerNameDropdownLabel || 'Name',
    });
    const inputId = `ai-organiser-speaker-${slugify(speaker.label)}`;
    labelEl.setAttribute('for', inputId);

    const input = renameRow.createEl('input', {
        cls: 'ai-organiser-speaker-review-rename-input',
        attr: {
            id: inputId,
            type: 'text',
            placeholder: tMin.speakerNameTypeFallback || 'Type a name…',
            'data-testid': 'speaker-rename-input',
        },
    });
    input.value = workingMapping[speaker.label] ?? '';
    cleanups.push(listen(input, 'input', () => onChange(input.value)));

    // Datalist of participant suggestions
    if (options.participants.length > 0) {
        const listId = `${inputId}-list`;
        input.setAttribute('list', listId);
        const datalist = renameRow.createEl('datalist', { attr: { id: listId } });
        for (const p of options.participants) {
            datalist.createEl('option', { attr: { value: p } });
        }
    }

    // "Same as…" merge dropdown — only render when ≥2 detected speakers.
    if (options.state.kind === 'pending' || options.state.kind === 'confirmed') {
        if (options.state.detected.length >= 2) {
            const sameAs = renameRow.createEl('select', {
                cls: 'ai-organiser-speaker-review-same-as',
                attr: { 'data-testid': 'speaker-same-as' },
            });
            const placeholder = sameAs.createEl('option', {
                attr: { value: '' },
                text: tMin.speakerSameAsLabel || 'Same as…',
            });
            placeholder.disabled = true;
            placeholder.selected = true;
            for (const other of options.state.detected) {
                if (other.label === speaker.label) continue;
                sameAs.createEl('option', {
                    attr: { value: other.label },
                    text: other.label,
                });
            }
            cleanups.push(
                listen(sameAs, 'change', () => {
                    if (!sameAs.value) return;
                    // Merge: this speaker takes the same resolved name as the
                    // selected other. We read the OTHER's current input value,
                    // not its original label — so the user can chain merges.
                    const otherInput = container.querySelector<HTMLInputElement>(
                        `#ai-organiser-speaker-${slugify(sameAs.value)}`
                    );
                    if (otherInput) {
                        input.value = otherInput.value;
                        onChange(otherInput.value);
                    }
                    sameAs.value = '';
                })
            );
        }
    }
}

function renderPreviewControl(
    container: HTMLElement,
    speaker: DetectedSpeaker,
    options: SpeakerReviewOptions,
    cleanups: Array<() => void>
): void {
    const tMin = options.t.minutes;

    // Suppress preview when timestamps unavailable (R1 H2). Render a muted
    // sub-label so the absence is explained, not silent.
    if (!options.timestampsAvailable || speaker.firstUtteranceStartMs === undefined || !options.preview) {
        const noPrev = container.createSpan({
            cls: 'ai-organiser-speaker-review-no-preview',
            text: tMin.speakerPreviewUnavailable || 'Audio preview unavailable for this transcript',
        });
        noPrev.addClass('ai-organiser-text-muted');
        return;
    }

    const btn = container.createEl('button', {
        cls: 'ai-organiser-speaker-review-play',
        attr: {
            'data-testid': 'speaker-play-preview',
            'aria-label': `${tMin.speakerPlayPreview || 'Play sample'} ${speaker.label}`,
        },
    });
    const icon = btn.createSpan();
    setIcon(icon, 'play');
    setTooltip(btn, tMin.speakerPlayPreview || 'Play sample');

    // One <audio> element per row; reused across clicks (avoids leaking many
    // <audio> nodes). HTML5 time-fragment URI gives a 5-second window.
    const audio = container.createEl('audio', {
        cls: 'ai-organiser-speaker-review-audio',
        attr: { preload: 'none' },
    });
    const startSec = (speaker.firstUtteranceStartMs / 1000).toFixed(2);
    const endSec = ((speaker.firstUtteranceStartMs + PREVIEW_DURATION_SECONDS * 1000) / 1000).toFixed(2);
    audio.src = `${options.preview.url}#t=${startSec},${endSec}`;

    cleanups.push(
        listen(btn, 'click', () => {
            // Reset to the fragment start each click so repeated taps replay
            // the same 5-second slice.
            try {
                audio.currentTime = Number(startSec);
                void audio.play();
            } catch {
                /* Silently ignore — browser may block autoplay; user can use
                   native audio controls if available. */
            }
        })
    );
}

function renderPendingActions(
    root: HTMLElement,
    options: SpeakerReviewOptions,
    getMapping: () => SpeakerMapping,
    cleanups: Array<() => void>
): void {
    const tMin = options.t.minutes;
    const actions = root.createDiv({ cls: 'ai-organiser-speaker-review-actions' });

    const skipBtn = actions.createEl('button', {
        cls: 'ai-organiser-speaker-review-skip',
        text: tMin.speakerSkipButton || 'Skip — labels look fine',
        attr: { 'data-testid': 'speaker-skip-btn' },
    });
    cleanups.push(listen(skipBtn, 'click', () => options.onSkip()));

    const confirmBtn = actions.createEl('button', {
        cls: 'ai-organiser-speaker-review-confirm mod-cta',
        text: tMin.speakerConfirmButton || 'Confirm speakers',
        attr: { 'data-testid': 'speaker-confirm-btn' },
    });
    cleanups.push(
        listen(confirmBtn, 'click', () => {
            const mapping = getMapping();
            const valid = validateMapping(mapping, options.state);
            if (!valid) {
                setTooltip(confirmBtn, tMin.confirmSpeakersFirst || 'Confirm speaker names before generating minutes');
                confirmBtn.addClass('is-invalid');
                return;
            }
            confirmBtn.removeClass('is-invalid');
            options.onConfirm(mapping);
        })
    );
}

// ============================================================================
// Helpers
// ============================================================================

function validateMapping(
    mapping: SpeakerMapping,
    state: SpeakerReviewState
): boolean {
    if (state.kind !== 'pending') return false;
    for (const speaker of state.detected) {
        const name = mapping[speaker.label]?.trim();
        if (!name) return false;
    }
    return true;
}

function seedMapping(state: SpeakerReviewState): SpeakerMapping {
    if (state.kind === 'confirmed') return { ...state.mapping };
    return {};
}

function flushCleanups(cleanups: Array<() => void>): void {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        try {
            fn?.();
        } catch {
            // Best-effort.
        }
    }
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
