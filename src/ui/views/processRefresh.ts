/** Kept apart from the view so the commands and the review windows can ask for a refresh without importing the view. */
import type { App } from 'obsidian';

export const PROCESS_VIEW_TYPE = 'ai-organiser-process';

interface Refreshable { refresh(): void }
const isRefreshable = (view: unknown): view is Refreshable => typeof view === 'object' && view !== null && typeof (view as Refreshable).refresh === 'function';

/** Ask every open Process view to read again (a review or a send just changed what it lists). */
export function refreshProcessViews(app: App): void {
    for (const leaf of app.workspace.getLeavesOfType(PROCESS_VIEW_TYPE)) if (isRefreshable(leaf.view)) leaf.view.refresh();
}
