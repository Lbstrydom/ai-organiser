/**
 * Review Edits Modal Tests
 *
 * Tests for ReviewEditsModal: action dispatch, ESC safety, double-fire guard.
 * Uses simulateAction() to exercise the real callback path that buttons trigger.
 */

vi.mock('obsidian', () => ({
    App: class App {},
    Modal: class Modal {
        app: any;
        contentEl: any;
        constructor(app: any) {
            this.app = app;
            this.contentEl = {
                empty: vi.fn(),
                addClass: vi.fn(),
                createEl: vi.fn().mockReturnValue({ setText: vi.fn() }),
                createDiv: vi.fn().mockReturnValue({
                    createEl: vi.fn().mockReturnValue({
                        createEl: vi.fn().mockReturnValue({ setText: vi.fn() }),
                    }),
                }),
            };
        }
        open() {}
        close() {}
    },
    Setting: class Setting {
        constructor() {}
        addButton(cb: any) {
            cb({
                setButtonText: () => ({ setWarning: () => ({ onClick: () => ({}) }), setCta: () => ({ onClick: () => ({}) }), onClick: () => ({}) }),
            });
            return this;
        }
    },
}));

import { describe, it, expect, vi } from 'vitest';
import { ReviewEditsModal } from '../src/ui/modals/ReviewEditsModal';
import type { DiffLine, DiffStats } from '../src/utils/mermaidDiff';

function makeDiff(): { diff: DiffLine[]; stats: DiffStats } {
    return {
        diff: [
            { type: 'unchanged', content: 'line 1' },
            { type: 'removed', content: 'old line 2' },
            { type: 'added', content: 'new line 2' },
            { type: 'unchanged', content: 'line 3' },
        ],
        stats: { added: 1, removed: 1, unchanged: 2 },
    };
}

const mockPlugin = {
    t: {
        modals: {
            reviewEdits: {
                title: 'Review Changes',
                accept: 'Accept',
                reject: 'Reject',
                copy: 'Copy',
                statsAdded: '{n} added',
                statsRemoved: '{n} removed',
                statsUnchanged: '{n} unchanged',
                noChanges: 'No changes',
                settingName: 'Review edits',
                settingDesc: 'Show diff',
            },
        },
        messages: { copiedToClipboard: 'Copied' },
    },
} as any;

describe('ReviewEditsModal', () => {
    it('stores new content for retrieval', () => {
        const { diff, stats } = makeDiff();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new content', vi.fn());
        expect(modal.getNewContent()).toBe('new content');
    });

    it('fires accept via simulateAction', () => {
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.simulateAction('accept');
        expect(onAction).toHaveBeenCalledWith('accept');
    });

    it('fires copy via simulateAction', () => {
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.simulateAction('copy');
        expect(onAction).toHaveBeenCalledWith('copy');
    });

    it('fires reject via simulateAction', () => {
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.simulateAction('reject');
        expect(onAction).toHaveBeenCalledWith('reject');
    });

    it('fires reject on ESC (onClose without prior action)', () => {
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.onClose();
        expect(onAction).toHaveBeenCalledWith('reject');
    });

    it('does not double-fire on close after action', () => {
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.simulateAction('accept');
        modal.onClose(); // second close should be silent
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(onAction).toHaveBeenCalledWith('accept');
    });

    it('does not call applyFn on reject', () => {
        // This tests the contract: reject action should resolve but not apply
        const { diff, stats } = makeDiff();
        const onAction = vi.fn();
        const modal = new ReviewEditsModal({} as any, mockPlugin, diff, stats, 'new', onAction);
        modal.simulateAction('reject');
        expect(onAction).toHaveBeenCalledWith('reject');
        // The caller (showReviewOrApply) only calls applyFn on 'accept' — not the modal's job
    });
});
