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
import { Notice } from 'obsidian';
import { assertWritableActive } from '../core/protectedPaths';

let activePathProvider: (() => string | null) | null = null;
let messageProvider: (() => string) | null = null;

export function installActiveNoteGuard(getActivePath: (() => string | null) | null, getMessage: (() => string) | null): void {
    activePathProvider = getActivePath;
    messageProvider = getMessage;
}

/** True when the active note may be changed. Fires the "protected" notice and returns false otherwise. */
export function guardActiveNote(): boolean {
    const path = activePathProvider?.() ?? null;
    if (!path) return true;
    if (assertWritableActive('modify', path).ok) return true;
    new Notice(messageProvider ? messageProvider() : 'This note is in a protected folder, so AI Organiser did not change it.', 6000);
    return false;
}
