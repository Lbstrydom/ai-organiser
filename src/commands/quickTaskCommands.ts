/**
 * "Make a Google task": one task from a note, or from the selected text, written by the person. No model reads the note; the
 * task goes through the sweep's own review, approval record, report and export, so its list lock, duplicate protection and the
 * source check before sending all apply unchanged. The note is never written to. A note in an inbox folder may be marked as
 * swept from the window (the person's choice); a note anywhere else is never marked.
 *
 * Offered from the file menu, the editor menu and the command picker, only while Google Tasks export is on.
 */
import { actionName } from '../core/actionRegistry';
import { Menu, Notice, TFile, type Editor } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { normalisePath, isInsideOrEqual } from '../core/protectedPaths';
import { isFeatureEnabled } from '../services/featureService';
import { logger } from '../utils/logger';
import { buildSnapshot } from '../services/inboxSweep/noteSnapshot';
import { guardSnapshot, policyRevisionOf } from '../services/inboxSweep/sweepGuard';
import { sweepPolicy } from '../services/inboxSweep/sweepCommit';
import { validateReportPath } from '../services/inboxSweep/sweepReport';
import { resolveSweepContexts } from '../services/inboxSweep/sweepContexts';
import type { NoteProposals } from '../services/inboxSweep/sweepService';
import { review } from './inboxSweepCommands';

/** The longest selection taken as a starting title; a task title is one line. */
const MAX_START = 300;

/** The selected text as a one-line starting title, or '' to use the note's title. */
export function startingText(selection: string | null | undefined): string {
    const line = (selection ?? '').replace(/\s+/g, ' ').trim();
    return line.length > MAX_START ? line.slice(0, MAX_START).trimEnd() : line;
}

/** A note in one of the sweep's inbox folders. */
export function inInbox(path: string, folders: readonly string[]): boolean {
    const p = normalisePath(path);
    return folders.map(normalisePath).filter((f) => f !== '').some((f) => isInsideOrEqual(p, f));
}

/** Why a quick task cannot start, as a guidance code, or null. Checked before the note is read. */
export function quickTaskBlocker(plugin: AIOrganiserPlugin): string | null {
    const s = plugin.settings;
    if (!s.tasksListId) return 'tasks-no-list';
    if (!validateReportPath(s.sweepReportPath, s.protectedFolders).ok) return 'sweep-report-invalid';
    return null;
}

/** The sweep report itself is never a source of a task. */
const isReport = (plugin: AIOrganiserPlugin, file: TFile): boolean => normalisePath(file.path) === normalisePath(plugin.settings.sweepReportPath);

let open = false;

export async function runQuickTask(plugin: AIOrganiserPlugin, file: TFile, selection?: string): Promise<void> {
    const notice = (code: string): void => { new Notice(formatGuidance(describeError(plugin.t, code)), 9000); };
    if (open) return;
    const blocker = quickTaskBlocker(plugin);
    if (blocker) { notice(blocker); return; }
    open = true;
    try {
        const text = await plugin.app.vault.read(file);
        // The same keep-out rules the export checks again before sending: a kept-out note is refused here, not after the review.
        const policy = sweepPolicy(plugin);
        const revision = await policyRevisionOf(policy);
        const snap = await buildSnapshot(file.path, text, revision);
        if (!guardSnapshot(snap, policy, revision).allowed) { notice('quick-task-kept-out'); return; }
        const note: NoteProposals = { path: file.path, contentHash: snap.contentHash, items: [], dropped: 0, truncated: false };
        await review(plugin, [note], resolveSweepContexts(plugin.settings), undefined, {
            text: startingText(selection),
            allowSwept: inInbox(file.path, plugin.settings.sweepInboxFolders),
        });
    } catch (e) {
        logger.error('Sweep', 'Quick task failed', e);
        notice('unknown');
    } finally {
        open = false;
    }
}

const offered = (plugin: AIOrganiserPlugin, file: unknown): file is TFile =>
    isFeatureEnabled(plugin.settings, 'google-tasks-export') && file instanceof TFile && file.extension === 'md' && !isReport(plugin, file);

export function registerQuickTask(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({
        id: 'make-google-task',
        name: actionName(t, 'make-google-task'),
        icon: 'list-plus',
        checkCallback: (checking) => {
            const file = plugin.app.workspace.getActiveFile();
            if (!offered(plugin, file)) return false;
            if (!checking) {
                const selection = plugin.app.workspace.activeEditor?.editor?.getSelection();
                void runQuickTask(plugin, file, selection);
            }
            return true;
        },
    });
    plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (!offered(plugin, file)) return;
        menu.addItem((item) => item.setTitle(t.commands.makeGoogleTask).setIcon('list-plus').onClick(() => { void runQuickTask(plugin, file); }));
    }));
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view) => {
        const file = view.file;
        if (!offered(plugin, file)) return;
        const selection = editor.getSelection();
        menu.addItem((item) => item.setTitle(t.commands.makeGoogleTask).setIcon('list-plus').onClick(() => { void runQuickTask(plugin, file, selection); }));
    }));
}
