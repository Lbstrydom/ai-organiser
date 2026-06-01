/**
 * Tests for PolishSelectorModal — UI contract with an injected onSubmit stub
 * (plan §9.1). Drives the mock DOM via _dispatch; pokes handleSubmit directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { PolishSelectorModal, formatFindingsForSlide } from '../src/ui/modals/PolishSelectorModal';
import type { PolishSubmit, PolishSelectorOptions } from '../src/ui/modals/PolishSelectorModal';
import { App } from './mocks/obsidian';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import type { QualityFinding } from '../src/services/chat/presentationTypes';
import type { Translations } from '../src/i18n/types';

function makeT(): Translations['modals']['polishSelector'] {
    return {
        title: 'Polish slides',
        privacyNotice: 'Unselected slides are sent as context but will not be modified.',
        deckWideFindingsHeading: 'Deck-wide issues',
        allSlides: 'All slides',
        allSlidesDescription: 'Polish the entire deck in one pass',
        rowInstructionLabel: 'Polish instructions for slide {n}: {title}',
        rowInstructionPlaceholder: 'No auto-detected issues — describe what you would like polished',
        actionButton: 'Polish {n} selected',
        actionButtonAll: 'Polish all',
        actionButtonSubmitting: 'Polishing…',
        cancel: 'Cancel',
        progressLabel: 'Polishing selected slides…',
        versionLabel: "Polish slides {slideNumbers} — '{preview}…'",
        errorByCode: {
            'aborted': 'cancelled',
            'empty-selections': 'empty',
            'duplicate-selection-index': 'dup-sel',
            'selection-out-of-range': 'oor',
            'deck-too-large': 'too-large',
            'llm-call-failed': 'llm-fail',
            'malformed-json': 'malformed',
            'shape-mismatch': 'shape',
            'duplicate-returned-index': 'dup-ret',
            'index-set-mismatch': 'set-mismatch',
            'invalid-slide-schema': 'bad-slide',
            'invalid-deck-after-splice': 'bad-deck',
            'unexpected-exception': 'unexpected',
        },
    };
}

const findings: QualityFinding[] = [
    { slideIndex: 1, issue: 'Subtitle overflows', suggestion: 'tighten to 8 words', severity: 'HIGH' },
    { slideIndex: 1, issue: 'Card contrast low', suggestion: 'bump to 4.5:1', severity: 'MEDIUM' },
];

function makeModal(
    onSubmit: PolishSelectorOptions['onSubmit'] = vi.fn(async () => ({ ok: true as const })),
    onClose: () => void = vi.fn(),
) {
    const modal = new PolishSelectorModal(
        new App() as never,
        coffeeDeckIr,
        findings,
        makeT(),
        { onSubmit, onClose },
    );
    return { modal, onSubmit, onClose };
}

/** Recursive search for the first element whose `role` attribute matches. */
function findByRole(el: any, role: string): any | null {
    if (el._attributes?.role === role) return el;
    for (const child of el.children ?? []) {
        const hit = findByRole(child, role);
        if (hit) return hit;
    }
    return null;
}

describe('PolishSelectorModal — construction', () => {
    it('pre-fills rowStates from findings (one line per finding)', () => {
        const { modal } = makeModal();
        const states = (modal as any).rowStates;
        expect(states[1].instruction).toBe(formatFindingsForSlide(findings, 1));
        expect(states[1].instruction.split('\n')).toHaveLength(2);
        expect(states[0].instruction).toBe('');
        expect(states[2].instruction).toBe('');
    });
});

describe('PolishSelectorModal — onOpen render', () => {
    it('renders privacy notice (role=note), rows, error banner, action + cancel', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const notice = findByRole(modal.contentEl, 'note');
        expect(notice).not.toBeNull();
        expect(notice.textContent).toBe(makeT().privacyNotice);

        expect((modal as any).rowCheckboxEls).toHaveLength(coffeeDeckIr.slides.length);
        expect((modal as any).rowTextareaEls).toHaveLength(coffeeDeckIr.slides.length);
        expect((modal as any).allSlidesCheckboxEl).not.toBeNull();
        expect((modal as any).cancelBtnEl).not.toBeNull();
        expect((modal as any).actionBtnEl).not.toBeNull();

        const banner = (modal as any).errorBannerEl;
        expect(banner.getAttribute('role')).toBe('alert');
        expect(banner.hasClass('is-visible')).toBe(false);
        modal.onClose();
    });

    it('row textarea pre-fills findings with placeholder; empty rows are blank', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const tas = (modal as any).rowTextareaEls;
        expect(tas[1].value.split('\n')).toHaveLength(2);
        expect(tas[1].value).toMatch(/^\[(HIGH|MEDIUM|LOW)\] .+ → .+$/m);
        expect(tas[2].value).toBe('');
        expect(tas[2].getAttribute('placeholder')).toBe(makeT().rowInstructionPlaceholder);
        modal.onClose();
    });

    it('row checkbox label contains the slide title (a11y linkage)', () => {
        const { modal } = makeModal();
        modal.onOpen();
        // The label sits as a sibling in the row; assert the title text is present.
        const titles = coffeeDeckIr.slides.map(s => s.title ?? '');
        const allText: string[] = [];
        const collect = (el: any) => { if (el.textContent) allText.push(el.textContent); (el.children ?? []).forEach(collect); };
        collect(modal.contentEl);
        for (let i = 0; i < titles.length; i++) {
            if (titles[i]) expect(allText.some(t => t.includes(titles[i]))).toBe(true);
        }
        modal.onClose();
    });
});

describe('PolishSelectorModal — action button state', () => {
    it('disabled at 0 selections, enabled + relabelled on tick', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const btn = (modal as any).actionBtnEl;
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('Polish 0 selected');

        const cb = (modal as any).rowCheckboxEls[1];
        cb.checked = true;
        cb._dispatch('change');
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toBe('Polish 1 selected');
        modal.onClose();
    });

    it('All slides tick disables per-row affordances + relabels button', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const all = (modal as any).allSlidesCheckboxEl;
        all.checked = true;
        all._dispatch('change');
        expect((modal as any).actionBtnEl.textContent).toBe('Polish all');
        expect((modal as any).actionBtnEl.disabled).toBe(false);
        for (const cb of (modal as any).rowCheckboxEls) expect(cb.disabled).toBe(true);
        for (const ta of (modal as any).rowTextareaEls) expect(ta.disabled).toBe(true);
        modal.onClose();
    });

    it('action button uses native disabled, not aria-disabled', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const btn = (modal as any).actionBtnEl;
        expect(btn.getAttribute('aria-disabled')).toBeUndefined();
        expect(btn.disabled).toBe(true);
        modal.onClose();
    });
});

describe('PolishSelectorModal — submit + draft preservation', () => {
    it('selective submit passes the edited instruction', async () => {
        const onSubmit = vi.fn(async (_d: PolishSubmit) => ({ ok: true as const }));
        const { modal } = makeModal(onSubmit);
        modal.onOpen();
        const cb = (modal as any).rowCheckboxEls[1];
        cb.checked = true; cb._dispatch('change');
        const ta = (modal as any).rowTextareaEls[1];
        ta.value = 'custom'; ta._dispatch('input');
        await (modal as any).handleSubmit();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit.mock.calls[0][0]).toEqual({ kind: 'selective', selections: [{ slideIndex: 1, instruction: 'custom' }] });
        expect((modal as unknown as { isClosed: boolean }).isClosed).toBe(true);
    });

    it('All slides submit passes { kind: "all" }', async () => {
        const onSubmit = vi.fn(async (_d: PolishSubmit) => ({ ok: true as const }));
        const { modal } = makeModal(onSubmit);
        modal.onOpen();
        const all = (modal as any).allSlidesCheckboxEl;
        all.checked = true; all._dispatch('change');
        // Even with a row ticked, All slides wins.
        const cb = (modal as any).rowCheckboxEls[2];
        cb.checked = true; cb._dispatch('change');
        await (modal as any).handleSubmit();
        expect(onSubmit.mock.calls[0][0]).toEqual({ kind: 'all' });
    });

    it('error result keeps modal open, shows banner, preserves draft', async () => {
        const onSubmit = vi.fn(async () => ({ ok: false as const, error: 'simulated' }));
        const { modal } = makeModal(onSubmit);
        modal.onOpen();
        const cb = (modal as any).rowCheckboxEls[1];
        cb.checked = true; cb._dispatch('change');
        const ta = (modal as any).rowTextareaEls[1];
        ta.value = 'custom'; ta._dispatch('input');
        await (modal as any).handleSubmit();

        expect((modal as unknown as { isClosed: boolean }).isClosed).toBe(false);
        const banner = (modal as any).errorBannerEl;
        expect(banner.textContent).toBe('simulated');
        expect(banner.hasClass('is-visible')).toBe(true);
        // Draft preserved.
        expect((modal as any).rowStates[1].instruction).toBe('custom');
        expect((modal as any).rowStates[1].checked).toBe(true);
        // Controls re-enabled for retry.
        expect((modal as any).actionBtnEl.disabled).toBe(false);
        // Retry invokes onSubmit again with the same draft.
        await (modal as any).handleSubmit();
        expect(onSubmit).toHaveBeenCalledTimes(2);
        modal.onClose();
    });

    it('no-op when nothing selected (defence in depth beyond disabled button)', async () => {
        const onSubmit = vi.fn(async () => ({ ok: true as const }));
        const { modal } = makeModal(onSubmit);
        modal.onOpen();
        await (modal as any).handleSubmit();
        expect(onSubmit).not.toHaveBeenCalled();
        modal.onClose();
    });

    it('submitting state disables action but keeps Cancel enabled', async () => {
        let resolveSubmit: (v: { ok: true }) => void = () => {};
        const onSubmit = vi.fn(() => new Promise<{ ok: true }>(r => { resolveSubmit = r; }));
        const { modal } = makeModal(onSubmit as never);
        modal.onOpen();
        const cb = (modal as any).rowCheckboxEls[1];
        cb.checked = true; cb._dispatch('change');
        const submitPromise = (modal as any).handleSubmit();
        // Mid-flight: submitting state.
        expect((modal as any).actionBtnEl.textContent).toBe('Polishing…');
        expect((modal as any).actionBtnEl.disabled).toBe(true);
        expect((modal as any).cancelBtnEl.disabled).toBe(false);
        resolveSubmit({ ok: true });
        await submitPromise;
    });
});

describe('PolishSelectorModal — lifecycle', () => {
    it('onClose aborts, runs cleanups, fires opts.onClose, empties DOM', () => {
        const { modal, onClose } = makeModal();
        modal.onOpen();
        expect((modal as any).cleanups.length).toBeGreaterThan(0);
        modal.onClose();
        expect((modal as any).cleanups.length).toBe(0);
        expect((modal as any).abortController.signal.aborted).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(modal.contentEl.children.length).toBe(0);
    });

    it('stale listeners do not fire after close', () => {
        const { modal } = makeModal();
        modal.onOpen();
        const cb = (modal as any).rowCheckboxEls[1];
        modal.onClose();
        cb.checked = true;
        cb._dispatch('change'); // disposer removed the listener
        expect((modal as any).rowStates[1].checked).toBe(false);
    });
});
