import { Platform, MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { detectOneDriveFolders, buildFileUrl, formatMarkdownLink } from '../ui/utils/oneDriveLinkUtils';
import { tryNativeFilePicker, isNativeFilePickerAvailable } from '../ui/utils/filePickers';
import { getPath } from '../utils/desktopRequire';
import { OneDriveLinkModal, type PickOutcome, type ShareOutcome } from '../ui/modals/OneDriveLinkModal';
import { captureSnapshot, applyNoteEdit, type EditSnapshot } from '../services/noteEdit/applyNoteEdit';
import { logger } from '../utils/logger';

/**
 * Only well-formed `https://` share links are accepted (round-3 M1's scheme
 * allowlist — the only scheme this feature needs, since OneDrive/SharePoint
 * share links are always https — not an attempt to blocklist dangerous
 * schemes). Audit round-2 M1/M2: a prefix-only regex let a degenerate value
 * like `https://` (no host) through; `new URL()` is the standard way to
 * validate an absolute URL's actual structure, not just its prefix.
 */
function isSafeShareUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.host.length > 0;
    } catch {
        return false;
    }
}

/**
 * The actual orchestration, exported so it has a testable seam
 * (docs/plans/onedrive-link-insert.md §6, round-1 M5) — a test or
 * /persona-test calls this directly with a real EditSnapshot and a stubbed
 * picker/modal, bypassing the un-automatable native OS dialog entirely.
 */
export function runOneDriveLinkFlow(plugin: AIOrganiserPlugin, snapshot: EditSnapshot): void {
    const { app, t } = plugin;

    const onPickLocalFile = async (): Promise<PickOutcome> => {
        try {
            // Distinguish "the native picker isn't available at all"
            // (genuinely can't show a dialog — e.g. mobile) from "it's
            // available but the dialog call itself failed" (round-3 M4 —
            // tryNativeFilePicker's `null` return conflates both). round-5
            // M2: this MUST check the exact same dependency
            // tryNativeFilePicker itself uses (`@electron/remote`, via
            // isNativeFilePickerAvailable()) — an earlier version checked
            // the unrelated `electron` module via getElectron(), which could
            // pass while `@electron/remote` was still unavailable,
            // misreporting a genuine unavailability as an operational
            // failure.
            if (!isNativeFilePickerAvailable()) {
                new Notice(t.oneDriveLink.pickerUnavailableNotice);
                return 'failed';
            }

            const folders = detectOneDriveFolders();
            const paths = await tryNativeFilePicker(
                [{ name: 'All Files', extensions: ['*'] }],
                { multiSelections: false, defaultPath: folders[0] },
            );

            if (paths === null) {
                // Electron was available (checked above) — this null means
                // the dialog call itself failed operationally.
                new Notice(t.oneDriveLink.pickerFailedNotice);
                return 'failed';
            }
            if (paths.length === 0) return 'cancelled';

            const absolutePath = paths[0];
            const path = getPath();
            const displayName = path ? path.basename(absolutePath) : absolutePath;
            const localLink = buildFileUrl(absolutePath);
            if (localLink === null) {
                new Notice(t.oneDriveLink.unbuildablePathNotice);
                return 'failed';
            }

            // buildFileUrl's own output is always a well-formed URI — never
            // containing `<`/`>`/control chars — so this cannot return null here.
            const text = formatMarkdownLink(displayName, localLink)!;
            const result = await applyNoteEdit(plugin, {
                kind: 'cursor-insert',
                filePath: snapshot.filePath,
                baseline: snapshot.baseline,
                anchorSnippet: snapshot.cursorAnchor,
                text,
            }, {});
            // applyNoteEdit fires its own failure Notice per its documented
            // §5 failure matrix — no duplicate handling needed here.
            return result.ok ? 'inserted' : 'failed';
        } catch (error) {
            // round-3 M1/M3: defense-in-depth beyond OneDriveLinkModal's own
            // catch — an unexpected throw here still resolves to a typed
            // outcome rather than an unhandled rejection. round-5 M1: unlike
            // the other 'failed' paths above (each already fires its own
            // Notice), a genuinely unexpected exception has no prior Notice —
            // without one here the modal would silently re-enable with zero
            // user-visible feedback.
            logger.warn('OneDriveLink', `onPickLocalFile failed unexpectedly: ${String(error)}`);
            new Notice(t.oneDriveLink.unexpectedErrorNotice);
            return 'failed';
        }
    };

    const onSubmitShareLink = async (labelText: string, url: string): Promise<ShareOutcome> => {
        try {
            if (!isSafeShareUrl(url)) return 'invalid-link';

            const text = formatMarkdownLink(labelText, url);
            if (text === null) return 'invalid-link';

            const result = await applyNoteEdit(plugin, {
                kind: 'cursor-insert',
                filePath: snapshot.filePath,
                baseline: snapshot.baseline,
                anchorSnippet: snapshot.cursorAnchor,
                text,
            }, {});
            return result.ok ? 'inserted' : 'failed';
        } catch (error) {
            // round-5 M1: same rationale as onPickLocalFile's catch above —
            // an unexpected exception here has no prior Notice, so surface
            // one instead of silently re-enabling the modal.
            logger.warn('OneDriveLink', `onSubmitShareLink failed unexpectedly: ${String(error)}`);
            new Notice(t.oneDriveLink.unexpectedErrorNotice);
            return 'failed';
        }
    };

    new OneDriveLinkModal(app, t, onPickLocalFile, onSubmitShareLink).open();
}

export function registerOneDriveLinkCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'insert-onedrive-link',
        name: plugin.t.commands.insertOneDriveLink,
        icon: 'link',
        callback: () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.oneDriveLink.desktopOnlyNotice);
                return;
            }

            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) {
                new Notice(plugin.t.oneDriveLink.noActiveNoteNotice);
                return;
            }

            const snapshot = captureSnapshot(view);
            if (!snapshot) {
                new Notice(plugin.t.oneDriveLink.noActiveNoteNotice);
                return;
            }

            runOneDriveLinkFlow(plugin, snapshot);
        },
    });
}
