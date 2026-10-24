/**
 * The notes and canvases whose links decide whether an attachment is "in use".
 *
 * One definition, consumed by BOTH the vault-scope scan (which finds orphans) and the delete-time
 * re-check (which proves them). Excluded and plugin-managed folders are a tagging concept: a
 * recording embedded only in a note inside one of them is still in use, so they count here. Protected
 * folders count too (reading never writes). Keeping the two callers on one function is what prevents the
 * scan from calling a file "orphaned" that the re-check then refuses.
 */
import type { App, TFile } from 'obsidian';

/** Every markdown note and canvas in the vault. */
export function listAllReferrerFiles(app: App): TFile[] {
    return [
        ...app.vault.getMarkdownFiles(),
        ...app.vault.getFiles().filter((f) => f.extension === 'canvas'),
    ];
}
