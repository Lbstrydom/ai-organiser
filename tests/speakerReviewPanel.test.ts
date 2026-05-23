// @vitest-environment happy-dom
/**
 * Unit tests for src/ui/components/SpeakerReviewPanel (plan F2b).
 *
 * Coverage:
 *  - State-driven rendering: not-required / pending / confirmed / skipped / failed
 *  - Confirm CTA requires every row to have a name (R3 M1 invariant)
 *  - Skip emits onSkip() (no mapping required)
 *  - "Same as…" merge copies the target row's CURRENT input value
 *  - Preview button rendered ONLY when timestampsAvailable + preview handle non-null
 *  - When timestamps unavailable: "Audio preview unavailable" sub-label shown
 *  - Banner copy correct for each skipped reason + failed
 *  - rerender clears prior listeners
 *  - ARIA: role="group", aria-label per row, data-testid="speaker-row"
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { renderSpeakerReview } from '../src/ui/components/SpeakerReviewPanel';
import type {
    DetectedSpeaker,
    SpeakerMapping,
    SpeakerReviewState,
} from '../src/ui/components/speakerReviewState';
import type { AudioPreviewHandle } from '../src/ui/coordinators/AudioPreviewSource';
import type { Translations } from '../src/i18n/types';

// Minimal translations stub — only the keys the panel consumes.
const t: Translations = {
    minutes: {
        speakerReviewHeading: 'Confirm speakers',
        speakerReviewDescription: 'Detected {count} speakers — confirm or rename below',
        speakerReviewSinglePersonHint: 'Only one speaker detected — no review needed',
        speakerNameDropdownLabel: 'Name',
        speakerNameUnconfirmed: 'Unnamed',
        speakerNameTypeFallback: 'Type a name…',
        speakerSameAsLabel: 'Same as…',
        speakerPlayPreview: 'Play sample',
        speakerPreviewUnavailable: 'Audio preview unavailable for this transcript',
        speakerOccurrenceCountLabel: '{count} segments',
        speakerConfirmButton: 'Confirm speakers',
        speakerSkipButton: 'Skip — labels look fine',
        speakerEditAfterConfirm: 'Edit',
        speakerDetectionFailedBanner: 'Speaker detection failed',
        speakerDetectionUnavailableBanner: 'Audio timestamps unavailable',
        speakerLabellingThrewBanner: 'Speaker labelling could not run',
        confirmSpeakersFirst: 'Confirm speaker names first',
    },
} as unknown as Translations;

function polyfill(el: HTMLElement): HTMLElement {
    const e = el as unknown as Record<string, unknown>;
    e.empty = (): void => { while (el.firstChild) el.removeChild(el.firstChild); };
    e.addClass = (c: string): void => el.classList.add(c);
    e.removeClass = (c: string): void => el.classList.remove(c);
    e.toggleClass = (c: string, on?: boolean): void => {
        if (on === undefined) el.classList.toggle(c);
        else if (on) el.classList.add(c);
        else el.classList.remove(c);
    };
    e.setText = (txt: string): void => { el.textContent = txt; };
    e.createEl = (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement(tag);
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    e.createDiv = (opts?: { cls?: string; text?: string }): HTMLElement => {
        const child = document.createElement('div');
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    e.createSpan = (opts?: { cls?: string; text?: string }): HTMLElement => {
        const child = document.createElement('span');
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    return el;
}

function makeRoot(): HTMLElement {
    return polyfill(document.createElement('div'));
}

function makeSpeaker(label: string, opts?: Partial<DetectedSpeaker>): DetectedSpeaker {
    return {
        label,
        firstUtteranceStartMs: 12_000,
        firstUtteranceText: `${label} speaking first`,
        occurrenceCount: 3,
        ...opts,
    };
}

function makePreview(): AudioPreviewHandle {
    return { url: 'blob:fake', dispose: vi.fn() };
}

function baseOptions(state: SpeakerReviewState, overrides: Partial<{
    participants: string[];
    preview: AudioPreviewHandle | null;
    timestampsAvailable: boolean;
    onConfirm: (m: SpeakerMapping) => void;
    onSkip: () => void;
    onEditAfterConfirm: () => void;
}> = {}) {
    // `preview` uses 'in' so callers can override with null explicitly (??
    // would coalesce null back to the default makePreview() handle).
    return {
        state,
        participants: overrides.participants ?? ['Sarah', 'Marco', 'Pat'],
        preview: 'preview' in overrides ? overrides.preview as AudioPreviewHandle | null : makePreview(),
        timestampsAvailable: overrides.timestampsAvailable ?? true,
        t,
        onConfirm: overrides.onConfirm ?? vi.fn(),
        onSkip: overrides.onSkip ?? vi.fn(),
        onEditAfterConfirm: overrides.onEditAfterConfirm,
    };
}

function getButton(root: HTMLElement, text: string): HTMLButtonElement | null {
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined ?? null;
}

describe('SpeakerReviewPanel — not-required state', () => {
    it('renders nothing', () => {
        const root = makeRoot();
        renderSpeakerReview(root, baseOptions({ kind: 'not-required' }));
        // The panel container itself IS created; but its contents should be empty.
        expect(root.querySelector('.ai-organiser-speaker-review-header')).toBeNull();
    });
});

describe('SpeakerReviewPanel — pending state', () => {
    it('renders one row per detected speaker with required ARIA attributes', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B'), makeSpeaker('Speaker C')];
        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        const rows = root.querySelectorAll('[data-testid="speaker-row"]');
        expect(rows.length).toBe(3);
        rows.forEach((row) => {
            expect(row.getAttribute('role')).toBe('group');
            expect(row.getAttribute('aria-label')).toMatch(/^Speaker /i);
        });
    });

    it('Confirm with all rows filled fires onConfirm with the mapping', () => {
        const onConfirm = vi.fn();
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { onConfirm }));

        const inputs = root.querySelectorAll<HTMLInputElement>('[data-testid="speaker-rename-input"]');
        expect(inputs.length).toBe(2);
        inputs[0].value = 'Sarah';
        inputs[0].dispatchEvent(new Event('input'));
        inputs[1].value = 'Marco';
        inputs[1].dispatchEvent(new Event('input'));

        getButton(root, 'Confirm speakers')!.click();

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(onConfirm.mock.calls[0][0]).toEqual({ 'Speaker A': 'Sarah', 'Speaker B': 'Marco' });
    });

    it('Confirm with empty rows does NOT fire onConfirm (validates first)', () => {
        const onConfirm = vi.fn();
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { onConfirm }));

        getButton(root, 'Confirm speakers')!.click();
        expect(onConfirm).not.toHaveBeenCalled();

        // The button gets is-invalid class to surface the failure visually.
        expect(getButton(root, 'Confirm speakers')!.classList.contains('is-invalid')).toBe(true);
    });

    it('Skip fires onSkip without requiring any input', () => {
        const onSkip = vi.fn();
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { onSkip }));

        getButton(root, 'Skip — labels look fine')!.click();

        expect(onSkip).toHaveBeenCalledOnce();
    });

    it('shows preview button when timestampsAvailable=true + preview handle present', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { timestampsAvailable: true }));

        expect(root.querySelector('[data-testid="speaker-play-preview"]')).not.toBeNull();
        expect(root.textContent).not.toContain('Audio preview unavailable');
    });

    it('suppresses preview button when timestampsAvailable=false (R1 H2)', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { timestampsAvailable: false }));

        expect(root.querySelector('[data-testid="speaker-play-preview"]')).toBeNull();
        expect(root.textContent).toContain('Audio preview unavailable');
    });

    it('suppresses preview button when preview handle is null', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        renderSpeakerReview(
            root,
            baseOptions({ kind: 'pending', detected }, { timestampsAvailable: true, preview: null })
        );

        expect(root.querySelector('[data-testid="speaker-play-preview"]')).toBeNull();
        expect(root.textContent).toContain('Audio preview unavailable');
    });

    it('suppresses preview when firstUtteranceStartMs is undefined', () => {
        const root = makeRoot();
        const detected = [
            makeSpeaker('Speaker A', { firstUtteranceStartMs: undefined }),
        ];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        expect(root.querySelector('[data-testid="speaker-play-preview"]')).toBeNull();
    });

    it('renders "Same as…" merge dropdown when ≥2 speakers detected', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        const merges = root.querySelectorAll('[data-testid="speaker-same-as"]');
        expect(merges.length).toBe(2);
        // Each select offers the OTHER speakers as options (plus the placeholder).
        const aMerge = merges[0] as HTMLSelectElement;
        const options = Array.from(aMerge.querySelectorAll('option')).map((o) => o.value);
        expect(options).toContain('Speaker B');
        expect(options).not.toContain('Speaker A');
    });

    it('does NOT render Same as… when only 1 speaker detected', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        expect(root.querySelectorAll('[data-testid="speaker-same-as"]').length).toBe(0);
    });

    it('"Same as…" merge copies the target row\'s current input value', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A'), makeSpeaker('Speaker B')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        const inputs = root.querySelectorAll<HTMLInputElement>('[data-testid="speaker-rename-input"]');
        // Speaker B gets a name first.
        inputs[1].value = 'Sarah';
        inputs[1].dispatchEvent(new Event('input'));

        // Speaker A picks "Same as Speaker B" — should adopt 'Sarah'.
        const aMerge = root.querySelectorAll<HTMLSelectElement>('[data-testid="speaker-same-as"]')[0];
        aMerge.value = 'Speaker B';
        aMerge.dispatchEvent(new Event('change'));

        expect(inputs[0].value).toBe('Sarah');
    });

    it('shows "only one speaker" hint when detected.length === 1', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }));

        expect(root.textContent).toContain('Only one speaker detected');
    });
});

describe('SpeakerReviewPanel — confirmed state', () => {
    it('renders rows seeded with the existing mapping values', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];
        renderSpeakerReview(
            root,
            baseOptions({ kind: 'confirmed', detected, mapping: { 'Speaker A': 'Sarah' } })
        );

        const input = root.querySelector<HTMLInputElement>('[data-testid="speaker-rename-input"]');
        expect(input?.value).toBe('Sarah');
    });

    it('shows Edit button when onEditAfterConfirm is provided', () => {
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];
        const onEdit = vi.fn();
        renderSpeakerReview(
            root,
            baseOptions({ kind: 'confirmed', detected, mapping: { 'Speaker A': 'Sarah' } }, { onEditAfterConfirm: onEdit })
        );

        const editBtn = getButton(root, 'Edit');
        expect(editBtn).not.toBeNull();
        editBtn!.click();
        expect(onEdit).toHaveBeenCalledOnce();
    });
});

describe('SpeakerReviewPanel — skipped + failed states', () => {
    it('renders the detection-failed banner', () => {
        const root = makeRoot();
        renderSpeakerReview(root, baseOptions({
            kind: 'skipped',
            detected: [],
            reason: 'detection-failed',
        }));

        expect(root.textContent).toContain('Speaker detection failed');
    });

    it('renders the detection-unavailable banner', () => {
        const root = makeRoot();
        renderSpeakerReview(root, baseOptions({
            kind: 'skipped',
            detected: [],
            reason: 'detection-unavailable',
        }));

        expect(root.textContent).toContain('Audio timestamps unavailable');
    });

    it('user-skip renders no banner (silent — user made a conscious choice)', () => {
        const root = makeRoot();
        renderSpeakerReview(root, baseOptions({
            kind: 'skipped',
            detected: [],
            reason: 'user-skip',
        }));

        expect(root.querySelector('.ai-organiser-speaker-review-banner')).toBeNull();
    });

    it('renders the labelling-threw banner on failed state', () => {
        const root = makeRoot();
        renderSpeakerReview(root, baseOptions({
            kind: 'failed',
            detected: [],
            error: 'boom',
        }));

        expect(root.textContent).toContain('Speaker labelling could not run');
    });
});

describe('SpeakerReviewPanel — rerender + destroy', () => {
    it('rerender clears prior listeners (no double-fire on confirm)', () => {
        const onConfirm = vi.fn();
        const root = makeRoot();
        const detected = [makeSpeaker('Speaker A')];

        const handle = renderSpeakerReview(root, baseOptions({ kind: 'pending', detected }, { onConfirm }));
        // Fill input then rerender with a fresh pending state.
        let input = root.querySelector<HTMLInputElement>('[data-testid="speaker-rename-input"]')!;
        input.value = 'Pat';
        input.dispatchEvent(new Event('input'));

        handle.rerender({ kind: 'pending', detected }, makePreview());

        // The captured `input` reference is detached. Click on the new button
        // (only the new listener should fire — value reset to empty so confirm
        // should NOT trigger onConfirm).
        getButton(root, 'Confirm speakers')!.click();
        expect(onConfirm).not.toHaveBeenCalled();

        // Refill and confirm — onConfirm should fire EXACTLY once.
        input = root.querySelector<HTMLInputElement>('[data-testid="speaker-rename-input"]')!;
        input.value = 'Pat';
        input.dispatchEvent(new Event('input'));
        getButton(root, 'Confirm speakers')!.click();
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('destroy clears the DOM', () => {
        const root = makeRoot();
        const handle = renderSpeakerReview(root, baseOptions({
            kind: 'pending',
            detected: [makeSpeaker('Speaker A')],
        }));
        expect(root.textContent?.length ?? 0).toBeGreaterThan(0);

        handle.destroy();
        expect(root.textContent ?? '').toBe('');
    });
});
