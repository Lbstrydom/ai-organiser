/**
 * Review Edits Helper Tests
 *
 * Tests for showReviewOrApply: setting gating, diff cost avoidance,
 * no-change bypass, and the critical reject/copy-must-not-apply contract.
 */

// Track whether ReviewEditsModal was instantiated, and auto-fire a configurable action
let modalAutoAction: string | null = null;

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
    Notice: class Notice { constructor() {} },
}));

// Mock ReviewEditsModal to auto-fire the configured action on open()
vi.mock('../src/ui/modals/ReviewEditsModal', () => ({
    ReviewEditsModal: class MockReviewEditsModal {
        private onAction: any;
        constructor(_app: any, _plugin: any, _diff: any, _stats: any, _newContent: any, onAction: any) {
            this.onAction = onAction;
        }
        open() {
            if (modalAutoAction) {
                this.onAction(modalAutoAction);
            }
        }
    },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeLineDiff, getDiffStats, hasMeaningfulChanges } from '../src/utils/mermaidDiff';
import { showReviewOrApply } from '../src/utils/reviewEditsHelper';

function makePlugin(overrides: Record<string, any> = {}) {
    return {
        app: {},
        settings: { enableReviewedEdits: true, ...overrides },
        t: {
            modals: { reviewEdits: { title: '', accept: '', reject: '', copy: '', statsAdded: '', statsRemoved: '', statsUnchanged: '', noChanges: '', settingName: '', settingDesc: '' } },
            messages: { copiedToClipboard: 'Copied' },
        },
    } as any;
}

beforeEach(() => {
    modalAutoAction = null;
});

// ── Diff utility tests ──────────────────────────────────────────────────────

describe('diff utility (unit logic)', () => {
    it('detects no meaningful changes for identical content', () => {
        const diff = computeLineDiff('hello\nworld', 'hello\nworld');
        expect(hasMeaningfulChanges(diff)).toBe(false);
    });

    it('detects meaningful changes for different content', () => {
        const diff = computeLineDiff('hello\nworld', 'hello\nplanet');
        expect(hasMeaningfulChanges(diff)).toBe(true);
    });

    it('computes correct stats for a typical edit', () => {
        const diff = computeLineDiff('line 1\nline 2\nline 3', 'line 1\nmodified line 2\nline 3\nline 4');
        const stats = getDiffStats(diff);
        expect(stats.added).toBeGreaterThan(0);
        expect(stats.unchanged).toBeGreaterThan(0);
    });

    it('handles empty old content (all additions)', () => {
        const diff = computeLineDiff('', 'new line 1\nnew line 2');
        expect(getDiffStats(diff)).toEqual({ added: 2, removed: 0, unchanged: 0 });
    });

    it('handles empty new content (all removals)', () => {
        const diff = computeLineDiff('old line 1\nold line 2', '');
        expect(getDiffStats(diff)).toEqual({ added: 0, removed: 2, unchanged: 0 });
    });
});

// ── showReviewOrApply bypass paths ──────────────────────────────────────────

describe('showReviewOrApply bypass paths', () => {
    it('applies directly and skips diff when setting is disabled', async () => {
        const applyFn = vi.fn();
        const action = await showReviewOrApply(makePlugin({ enableReviewedEdits: false }), 'old', 'new', applyFn);

        expect(applyFn).toHaveBeenCalledTimes(1);
        expect(action).toBe('accept');
    });

    it('applies directly when content is identical (no diff cost for no-op)', async () => {
        const applyFn = vi.fn();
        const action = await showReviewOrApply(makePlugin(), 'same', 'same', applyFn);

        expect(applyFn).toHaveBeenCalledTimes(1);
        expect(action).toBe('accept');
    });
});

// ── showReviewOrApply action contract ───────────────────────────────────────

describe('showReviewOrApply action contract', () => {
    it('accept → calls applyFn and resolves accept', async () => {
        modalAutoAction = 'accept';
        const applyFn = vi.fn();
        const action = await showReviewOrApply(makePlugin(), 'old\nline', 'new\nline', applyFn);

        expect(action).toBe('accept');
        expect(applyFn).toHaveBeenCalledTimes(1);
    });

    it('reject → does NOT call applyFn and resolves reject', async () => {
        modalAutoAction = 'reject';
        const applyFn = vi.fn();
        const action = await showReviewOrApply(makePlugin(), 'old\nline', 'new\nline', applyFn);

        expect(action).toBe('reject');
        expect(applyFn).not.toHaveBeenCalled();
    });

    it('copy → does NOT call applyFn and resolves copy', async () => {
        modalAutoAction = 'copy';
        // Mock clipboard
        const originalClipboard = globalThis.navigator;
        Object.defineProperty(globalThis, 'navigator', {
            value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
            writable: true,
            configurable: true,
        });

        const applyFn = vi.fn();
        const action = await showReviewOrApply(makePlugin(), 'old\nline', 'new\nline', applyFn);

        expect(action).toBe('copy');
        expect(applyFn).not.toHaveBeenCalled();

        // Restore
        Object.defineProperty(globalThis, 'navigator', { value: originalClipboard, writable: true, configurable: true });
    });
});

// ── Settings default ────────────────────────────────────────────────────────

describe('settings default', () => {
    it('enableReviewedEdits defaults to true', async () => {
        const { DEFAULT_SETTINGS } = await import('../src/core/settings');
        expect(DEFAULT_SETTINGS.enableReviewedEdits).toBe(true);
    });
});
