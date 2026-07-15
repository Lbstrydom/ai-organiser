import { Platform, MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import {
    detectOneDriveFolders, buildFileUrl, formatMarkdownLink,
    classifyOneDriveEmbed, buildOneDriveEmbedBlock, buildOneDriveEmbedMarkerText, parseOneDriveEmbedMarkers,
} from '../ui/utils/oneDriveLinkUtils';
import { tryNativeFilePicker, isNativeFilePickerAvailable } from '../ui/utils/filePickers';
import { getPath } from '../utils/desktopRequire';
import { OneDriveLinkModal, type PickOutcome, type ShareOutcome } from '../ui/modals/OneDriveLinkModal';
import { OneDriveRefreshConfirmModal } from '../ui/modals/OneDriveRefreshConfirmModal';
import { captureSnapshot, applyNoteEdit, type EditSnapshot } from '../services/noteEdit/applyNoteEdit';
import {
    copyOneDriveFileIntoVault, findStaleOneDriveEmbeds, refreshOneDriveEmbed, type StaleOneDriveEmbed,
} from '../services/oneDriveEmbedService';
import { ok } from '../core/result';
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

            const insertText = async (text: string): Promise<PickOutcome> => {
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
            };

            // Visual-embed extension (brainstormed 2026-07-15): PDF/image and
            // Office formats get vault-copied so Obsidian can render them
            // natively (or open them in the system app on click) instead of
            // a bare file:// link. Any failure here — over the size cap, a
            // desktop-only fs guard, or an I/O error — gracefully degrades
            // to the original file:// link behavior below, never blocking
            // the insert entirely.
            const embedKind = classifyOneDriveEmbed(absolutePath);
            if (embedKind !== 'file-url') {
                const copyResult = await copyOneDriveFileIntoVault(app, absolutePath);
                if (copyResult.ok) {
                    const block = buildOneDriveEmbedBlock(
                        absolutePath, copyResult.value.vaultPath, copyResult.value.mtimeMs, embedKind,
                    );
                    if (block !== null) return insertText(block);
                    // block === null: source path had marker-unsafe characters —
                    // fall through to the file:// link below.
                } else if (copyResult.error === 'too-large') {
                    new Notice(t.oneDriveLink.embedTooLargeNotice);
                } else if (copyResult.error !== 'desktop-only') {
                    new Notice(t.oneDriveLink.embedFailedNotice);
                }
            }

            const localLink = buildFileUrl(absolutePath);
            if (localLink === null) {
                new Notice(t.oneDriveLink.unbuildablePathNotice);
                return 'failed';
            }
            // buildFileUrl's own output is always a well-formed URI — never
            // containing `<`/`>`/control chars — so this cannot return null here.
            return insertText(formatMarkdownLink(displayName, localLink)!);
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

/**
 * Refresh flow (brainstormed 2026-07-15): scans the active note's
 * `onedrive-embed` markers, stats each source file, and — after a single
 * confirm listing what changed — re-copies stale sources' bytes into their
 * existing vault-copied file, updating only the marker's `mtime` attribute.
 * Exported for the same testable-seam reason as `runOneDriveLinkFlow`.
 */
export function runOneDriveRefreshFlow(plugin: AIOrganiserPlugin, snapshot: EditSnapshot): void {
    const { app, t } = plugin;
    const markers = parseOneDriveEmbedMarkers(snapshot.baseline);
    if (markers.length === 0) {
        new Notice(t.oneDriveLink.refreshNoEmbedsNotice);
        return;
    }

    const stale = findStaleOneDriveEmbeds(markers);
    if (stale.length === 0) {
        new Notice(t.oneDriveLink.refreshUpToDateNotice);
        return;
    }

    const fileNames = stale.map((s) => s.marker.vaultPath.split('/').pop() ?? s.marker.vaultPath);
    new OneDriveRefreshConfirmModal(app, {
        title: t.oneDriveLink.refreshConfirmTitle,
        body: t.oneDriveLink.refreshConfirmBody,
        fileNames,
        confirmText: t.oneDriveLink.refreshConfirmConfirm,
        cancelText: t.oneDriveLink.refreshConfirmCancel,
        onConfirm: () => { void performOneDriveRefresh(plugin, snapshot, stale); },
        onCancel: () => { /* user declined — no changes */ },
    }).open();
}

async function performOneDriveRefresh(
    plugin: AIOrganiserPlugin,
    snapshot: EditSnapshot,
    stale: StaleOneDriveEmbed[],
): Promise<void> {
    const { app, t } = plugin;
    const refreshed: { source: string; vaultPath: string; newMtimeMs: number; raw: string }[] = [];
    let failures = 0;

    for (const entry of stale) {
        const result = await refreshOneDriveEmbed(app, entry);
        if (result.ok) {
            refreshed.push({
                source: entry.marker.source, vaultPath: entry.marker.vaultPath,
                newMtimeMs: result.value.mtimeMs, raw: entry.marker.raw,
            });
        } else {
            failures++;
            logger.warn('OneDriveLink', `Failed to refresh ${entry.marker.vaultPath}: ${result.error}`);
        }
    }

    if (refreshed.length === 0) {
        new Notice(t.oneDriveLink.refreshFailedNotice);
        return;
    }

    const editResult = await applyNoteEdit(plugin, {
        kind: 'composite',
        filePath: snapshot.filePath,
        baseline: snapshot.baseline,
        // Recomputed against whatever the note's LIVE content is at commit
        // time (no baseline gate) — a plain string replace of each stale
        // marker's exact prior text, never a regex over user content.
        recompute: (current) => {
            let next = current;
            for (const entry of refreshed) {
                const newMarker = buildOneDriveEmbedMarkerText(entry.source, entry.vaultPath, entry.newMtimeMs);
                if (newMarker === null) continue;
                next = next.split(entry.raw).join(newMarker);
            }
            return ok({ content: next });
        },
        // Live-testing finding (2026-07-15): the caller already gated this
        // write behind its OWN confirm — OneDriveRefreshConfirmModal, which
        // names the exact files about to change. Leaving the shared
        // Review-changes diff modal on (the applyNoteEdit default) means a
        // SECOND confirmation stacks on top of the first for a purely
        // mechanical mtime-attribute update, which is redundant friction
        // for the user (and, live-verified, silently stalls a script/
        // automation flow that only expects one confirm step).
    }, { review: false });

    if (!editResult.ok) return; // applyNoteEdit already fired its own failure Notice

    new Notice(
        failures > 0
            ? t.oneDriveLink.refreshPartialNotice
                .replace('{refreshed}', String(refreshed.length))
                .replace('{failed}', String(failures))
            : t.oneDriveLink.refreshDoneNotice.replace('{n}', String(refreshed.length)),
    );
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

    plugin.addCommand({
        id: 'refresh-onedrive-embed',
        name: plugin.t.commands.refreshOneDriveEmbed,
        icon: 'refresh-cw',
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

            runOneDriveRefreshFlow(plugin, snapshot);
        },
    });
}
