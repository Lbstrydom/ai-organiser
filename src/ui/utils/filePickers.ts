import { App, FuzzySuggestModal, TFile } from 'obsidian';
import { desktopRequire } from '../../utils/desktopRequire';

/**
 * File-extension filter for the native Electron open dialog.
 *
 * `extensions` are the bare extensions WITHOUT the leading dot
 * (e.g. `['docx', 'pdf']` — not `['.docx', '.pdf']`).
 */
export interface FilePickerFilter {
    name: string;
    extensions: string[];
}

interface ElectronRemote {
    dialog: {
        showOpenDialog: (opts: {
            properties: string[];
            filters: FilePickerFilter[];
        }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
}

/**
 * Open the native Electron file-open dialog. Desktop only.
 *
 * Returns:
 *  - `string[]` of absolute paths the user picked (empty when the user cancelled).
 *  - `null` when `@electron/remote` is unavailable — typically Obsidian Mobile, but
 *    also any environment where `desktopRequire` cannot resolve it. Callers MUST
 *    handle `null` explicitly (e.g. fall back to `openVaultFilePicker`).
 *
 * Defaults to multi-select to match the existing FreeChat attachment behaviour;
 * pass `{ multiSelections: false }` for single-file pickers.
 */
export async function tryNativeFilePicker(
    filters: FilePickerFilter[],
    options?: { multiSelections?: boolean }
): Promise<string[] | null> {
    try {
        const remote = desktopRequire<ElectronRemote>('@electron/remote');
        if (!remote) return null;
        const properties = ['openFile'];
        if (options?.multiSelections !== false) {
            properties.push('multiSelections');
        }
        const result = await remote.dialog.showOpenDialog({ properties, filters });
        if (result.canceled) return [];
        return result.filePaths;
    } catch {
        return null;
    }
}

/**
 * Open Obsidian's FuzzySuggestModal scoped to vault files.
 *
 * Ordering mirrors the original FreeChat picker: markdown files first, then
 * every other vault file. An optional `predicate` filters both lists; when
 * omitted, all vault files are listed.
 *
 * `onChoose` runs synchronously when the user selects an item. If async work
 * is required, wrap it in a fire-and-forget IIFE inside the callback so the
 * modal closes cleanly.
 */
export function openVaultFilePicker(
    app: App,
    options: {
        predicate?: (file: TFile) => boolean;
        placeholder?: string;
        onChoose: (file: TFile) => void;
    }
): void {
    const { predicate, placeholder, onChoose } = options;
    const vaultApp = app;

    class VaultFilePicker extends FuzzySuggestModal<TFile> {
        constructor(pickerApp: App) {
            super(pickerApp);
            if (placeholder) this.setPlaceholder(placeholder);
        }

        getItems(): TFile[] {
            const filter = predicate ?? ((): boolean => true);
            const md = vaultApp.vault.getMarkdownFiles().filter(filter);
            const nonMd = vaultApp.vault
                .getFiles()
                .filter((f: TFile) => !f.path.endsWith('.md') && filter(f));
            return md.concat(nonMd);
        }

        getItemText(item: TFile): string {
            return item.path;
        }

        onChooseItem(item: TFile): void {
            onChoose(item);
        }
    }

    new VaultFilePicker(app).open();
}
