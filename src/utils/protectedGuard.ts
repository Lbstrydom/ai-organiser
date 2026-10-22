/**
 * Guard for editor-level mutations of the open note.
 *
 * A few helpers edit the active note through its editor and never see a file path or the
 * plugin (insert at cursor, replace the selection). They call `guardActiveNote()` first: it
 * answers "may the plugin change the note that is open right now?", shows the standard
 * notice when not, and is a constant `true` when no protected folders are configured.
 *
 * `registerProtectedFolders` installs the providers; until then (tests, first load) nothing
 * is protected.
 */
import { Notice, type App, type Editor } from 'obsidian';
import { assertWritableActive, isProtectedActive } from '../core/protectedPaths';

let activePathProvider: (() => string | null) | null = null;
let editorPathProvider: ((editor: Editor) => string | null) | null = null;
let messageProvider: (() => string) | null = null;

export function installActiveNoteGuard(
    getActivePath: (() => string | null) | null,
    getMessage: (() => string) | null,
    getEditorPath?: ((editor: Editor) => string | null) | null,
): void {
    activePathProvider = getActivePath;
    messageProvider = getMessage;
    editorPathProvider = getEditorPath ?? null;
}

/**
 * True when the note may be changed. When the editor that is about to be mutated is passed, its
 * OWNING note is the one checked (so a delayed action that outlives a tab switch is still judged
 * against the right file); an editor whose note cannot be identified falls back to the active
 * note. Fires the "protected" notice and returns false otherwise.
 */
export function guardActiveNote(editor?: Editor): boolean {
    const path = (editor && editorPathProvider ? editorPathProvider(editor) : null) ?? activePathProvider?.() ?? null;
    if (!path) return true;
    if (assertWritableActive('modify', path).ok) return true;
    new Notice(messageProvider ? messageProvider() : 'This note is in a protected folder, so AI Organiser did not change it.', 6000);
    return false;
}

/**
 * True when renaming or moving this file would also rewrite a protected note: Obsidian updates
 * the links in every note that references the file, so those notes are part of the footprint.
 */
export function referrersProtectedActive(app: App, filePath: string): boolean {
    const resolved = (app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks;
    if (!resolved) return false;
    for (const [referrer, targets] of Object.entries(resolved)) {
        if (targets && targets[filePath] && isProtectedActive(referrer)) return true;
    }
    return false;
}
