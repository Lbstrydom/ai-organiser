/**
 * Review Edits Helper
 * One-liner helper to conditionally show the ReviewEditsModal before applying changes.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { computeLineDiff, getDiffStats, hasMeaningfulChanges } from './mermaidDiff';
import { ReviewEditsModal, type ReviewAction } from '../ui/modals/ReviewEditsModal';
export type { ReviewAction } from '../ui/modals/ReviewEditsModal';

/**
 * Show a diff review modal if enabled and changes are meaningful,
 * otherwise apply directly. Returns a Promise that resolves with the action taken.
 *
 * Diff computation is deferred until after the setting check to avoid
 * O(m*n) LCS cost when the feature is disabled.
 */
export function showReviewOrApply(
    plugin: AIOrganiserPlugin,
    oldContent: string,
    newContent: string,
    applyFn: () => void | Promise<void>
): Promise<ReviewAction> {
    // Fast exit — skip O(m*n) diff when feature is off
    if (!plugin.settings.enableReviewedEdits) {
        void applyFn();
        return Promise.resolve('accept');
    }

    const diff = computeLineDiff(oldContent, newContent);

    if (!hasMeaningfulChanges(diff)) {
        void applyFn();
        return Promise.resolve('accept');
    }

    const stats = getDiffStats(diff);

    return new Promise<ReviewAction>((resolve) => {
        const modal = new ReviewEditsModal(
            plugin.app,
            plugin,
            diff,
            stats,
            newContent,
            (action: ReviewAction) => { void (async () => {
                if (action === 'accept') {
                    await applyFn();
                } else if (action === 'copy') {
                    await navigator.clipboard.writeText(newContent);
                    new Notice(plugin.t.messages.copiedToClipboard || 'Copied to clipboard', 3000);
                }
                // 'reject' — do nothing
                resolve(action);
            })(); }
        );
        modal.open();
    });
}
