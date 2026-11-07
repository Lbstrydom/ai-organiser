/**
 * The one place an action runs (docs/plans/navigation-discoverability.md, decision 9).
 *
 * `{kind:'active'}` runs the command exactly as the palette does. Any other target runs the
 * action's binding below, an existing exported handler that already takes that file; an action
 * without a binding is never offered for a scoped target and is never run against the active
 * file as a substitute. Just before running, the target is checked again: the action is still
 * ready, the file still exists, a selection is unchanged. Handlers keep their own write guards
 * and `applyNoteEdit`; this module adds no write path.
 */
import { MarkdownView, Notice, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { ActionTarget, ActionTargetKind } from '../core/actionTarget';
import type { Availability } from '../core/actionAvailability';
import { handleNarrateActiveNote, openAudioPlayer } from '../commands/audioNarrationCommands';
import { runQuickTask } from '../commands/quickTaskCommands';
import { TranscribeOnlyModal } from '../ui/modals/TranscribeOnlyModal';
import { logger } from '../utils/logger';

type FileHandler = (plugin: AIOrganiserPlugin, file: TFile) => void | Promise<void>;
type FilesHandler = (plugin: AIOrganiserPlugin, files: readonly TFile[]) => void | Promise<void>;

interface TargetBinding {
    file?: FileHandler;
    files?: FilesHandler;
}

/** Scoped-target handlers, keyed by action id. Each points at an existing exported handler. */
export const ACTION_TARGET_HANDLERS: Readonly<Record<string, TargetBinding>> = Object.freeze({
    'narrate-note': { file: (p, f) => handleNarrateActiveNote(p, f) },
    'play-narration': { file: (p, f) => openAudioPlayer(p, f) },
    'transcribe-audio': { file: (p, f) => new TranscribeOnlyModal(p.app, p, f).open() },
    'make-google-task': { file: (p, f) => runQuickTask(p, f) },
    'smart-tag': {
        file: (p, f) => p.analyzeAndTagFiles([f]),
        files: (p, fs) => p.analyzeAndTagFiles([...fs]),
    },
});

/** Does the action accept this kind of target? */
export function acceptsTarget(actionId: string, kind: ActionTargetKind): boolean {
    if (kind === 'active') return true;
    const binding = ACTION_TARGET_HANDLERS[actionId];
    if (kind === 'file') return !!binding?.file;
    if (kind === 'files') return !!binding?.files;
    return false;
}

export interface RunContext {
    availabilityOf: (actionId: string) => Availability | null;
    reasonText: (state: Exclude<Availability['state'], 'ready'>) => string;
    staleTarget: string;
    /** Shown when the handler itself fails; the error is logged with the action id. */
    failed?: string;
}

/** Re-check the target right before running. Returns a reason when it must not run. */
export function targetStillValid(plugin: AIOrganiserPlugin, target: ActionTarget): boolean {
    // The vault must still hold the SAME object at the path: a file deleted and recreated under
    // the same name is a different file, and is refused.
    const vault = plugin.app.vault;
    const same = (f: TFile | TFolder): boolean => {
        const now = vault.getAbstractFileByPath(f.path);
        return now === f && (f instanceof TFile ? now instanceof TFile : now instanceof TFolder);
    };
    if (target.kind === 'file') return same(target.file);
    if (target.kind === 'folder') return same(target.folder);
    if (target.kind === 'files') return target.files.every(same);
    if (target.kind === 'selection') {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file?.path !== target.file.path) return false;
        const ed = view.editor;
        const text = ed.getRange(ed.offsetToPos(target.from), ed.offsetToPos(target.to));
        return text === target.text;
    }
    return true;
}

export function runAction(plugin: AIOrganiserPlugin, actionId: string, target: ActionTarget, ctx: RunContext): void {
    const availability = ctx.availabilityOf(actionId);
    if (!availability || availability.state !== 'ready') {
        new Notice(ctx.reasonText(availability && availability.state !== 'ready' ? availability.state : 'feature-off'), 6000);
        return;
    }
    if (target.kind === 'active') {
        (plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } })
            .commands.executeCommandById(`ai-organiser:${actionId}`);
        return;
    }
    if (!acceptsTarget(actionId, target.kind) || !targetStillValid(plugin, target)) {
        new Notice(ctx.staleTarget, 6000);
        return;
    }
    const binding = ACTION_TARGET_HANDLERS[actionId];
    const fail = (e: unknown): void => {
        logger.error('Actions', `Action ${actionId} failed`, e);
        if (ctx.failed) new Notice(ctx.failed, 6000);
    };
    try {
        const result = target.kind === 'file' ? binding.file!(plugin, target.file)
            : target.kind === 'files' ? binding.files!(plugin, target.files)
                : undefined;
        if (result instanceof Promise) result.catch(fail);
    } catch (e) {
        fail(e);
    }
}
