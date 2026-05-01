/**
 * Audio narration commands.
 *
 * Two surfaces (Phase I, frontend plan §2):
 *   1. Command palette / command picker — leaf inside Active Note → Export.
 *   2. File-menu right-click on a .md file in the file explorer.
 *
 * Both paths converge on `handleNarrateActiveNote(plugin, file?)`.
 */

import { Notice, TFile, type MenuItem, type Menu } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { noticeWithSettingsLink } from '../utils/noticeUtils';
import { withProgressResult } from '../services/progress';
import { statusBarBroker } from '../services/progress/statusBarBroker';
import { ensurePrivacyConsent } from '../services/privacyNotice';
import { CostConfirmModal } from '../ui/modals/CostConfirmModal';
import { AudioPlayerModal } from '../ui/modals/AudioPlayerModal';
import {
    prepareNarration,
    executeNarration,
} from '../services/audioNarration/audioNarrationService';
import { syncEmbed } from '../services/audioNarration/narrationEmbedManager';
import {
    decodeError,
    type NarrationError,
    type NarrationPhase,
    type NarrateOutcome,
} from '../services/audioNarration/narrationTypes';
import { JobInFlightError } from '../services/audioNarration/narrationJobRegistry';

/** Canonical command id — single source of truth (M5 fix). */
export const NARRATE_NOTE_CMD_ID = 'narrate-note' as const;
export const PLAY_NARRATION_CMD_ID = 'play-narration' as const;

interface NoticeMapping {
    message: string;
    durationMs: number;
}

/** Map a NarrationError to a localised Notice. Single mapping site (M1 fix). */
function mapErrorToNotice(error: NarrationError, plugin: AIOrganiserPlugin): NoticeMapping | null {
    const t = plugin.t.settings.audioNarration.notices;
    switch (error.code) {
        case 'EMPTY_CONTENT':
            return { message: t.empty, durationMs: 5000 };
        case 'NO_API_KEY':
            return { message: t.noKey, durationMs: 0 };  // settings link variant
        case 'CONSENT_DECLINED':
            return { message: t.consentDeclined, durationMs: 4000 };
        case 'IN_FLIGHT':
            return { message: t.inFlight, durationMs: 4000 };
        case 'ABORTED':
            return null;  // reporter already showed neutral "Cancelled"
        case 'TRANSFORM_FAILED':
        case 'ESTIMATE_FAILED':
            return { message: t.transformFailed.replace('{error}', error.message), durationMs: 6000 };
        case 'TTS_FAILED':
            return { message: t.failed.replace('{error}', error.message), durationMs: 6000 };
        case 'ENCODE_FAILED':
            return { message: t.encodeFailed.replace('{error}', error.message), durationMs: 6000 };
        case 'WRITE_FAILED':
            return { message: t.writeFailed.replace('{error}', error.message), durationMs: 6000 };
        case 'EMBED_FAILED':
            return { message: t.embedSkipped, durationMs: 5000 };
        case 'UNSUPPORTED_PLATFORM':
            return { message: t.unsupportedPlatform, durationMs: 8000 };
    }
    const exhaustive: never = error.code;
    return { message: String(exhaustive), durationMs: 5000 };
}

/** Show an error Notice. NO_API_KEY routes to a settings-link Notice. */
function showErrorNotice(plugin: AIOrganiserPlugin, error: NarrationError): void {
    const mapped = mapErrorToNotice(error, plugin);
    if (!mapped) return;
    if (error.code === 'NO_API_KEY') {
        noticeWithSettingsLink(plugin, mapped.message);
        return;
    }
    new Notice(mapped.message, mapped.durationMs);
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

function formatDurationDisplay(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function showSuccessNotice(plugin: AIOrganiserPlugin, outcome: NarrateOutcome): void {
    const t = plugin.t.settings.audioNarration.notices;
    const sizeStr = formatBytes(outcome.bytes);
    const durStr = formatDurationDisplay(outcome.durationSec);
    const text = t.success
        .replace('{size}', sizeStr)
        .replace('{duration}', durStr);

    const notice = new Notice(text, 0);  // sticky until dismissed
    const noticeEl = notice.messageEl?.parentElement ?? notice.messageEl;
    if (!noticeEl) return;
    const actionsEl = noticeEl.createDiv({ cls: 'ai-organiser-notice-actions' });

    const playBtn = actionsEl.createEl('button', { text: t.playWithControls, cls: 'mod-cta' });
    playBtn.addEventListener('click', () => {
        const file = plugin.app.vault.getAbstractFileByPath(outcome.filePath);
        if (file instanceof TFile) {
            new AudioPlayerModal(plugin.app, plugin, file).open();
        } else {
            void plugin.app.workspace.openLinkText(outcome.filePath, '', false);
        }
        notice.hide();
    });

    const openBtn = actionsEl.createEl('button', { text: t.open });
    openBtn.addEventListener('click', () => {
        void plugin.app.workspace.openLinkText(outcome.filePath, '', false);
        notice.hide();
    });

    const dismissBtn = actionsEl.createEl('button', { text: t.dismiss });
    dismissBtn.addEventListener('click', () => notice.hide());

    if (!outcome.embedUpdated && plugin.settings.audioNarrationEmbedInNote) {
        new Notice(t.embedSkipped, 6000);
    }
}

/**
 * Single entry point for both command-picker and file-menu surfaces.
 * @param file — optional TFile (passed by the file-menu surface). Defaults to the active file.
 */
export async function handleNarrateActiveNote(
    plugin: AIOrganiserPlugin,
    file?: TFile,
): Promise<void> {
    const t = plugin.t;
    const targetFile = file ?? plugin.app.workspace.getActiveFile();
    if (!targetFile) return;  // Obsidian shows its own no-file notice via command guard
    if (targetFile.extension !== 'md') return;

    // Snapshot path BEFORE any async work (G3 — TFile.path mutates on rename)
    const jobKey = targetFile.path;

    // Preflight UI (R2-M1) — status-bar tick only, no toast
    const preflightTicket = (plugin.busyStatusBarEl)
        ? statusBarBroker.acquire(plugin, t.progress.audioNarration.preparing)
        : null;

    let prepared;
    try {
        const prep = await prepareNarration(plugin, targetFile);
        if (!prep.ok) {
            showErrorNotice(plugin, decodeError(prep.error));
            return;
        }
        prepared = prep.value;

        // Idempotent-hit branch — skip cost modal, just sync embed and open
        if (prepared.existingFile) {
            const sync = await syncEmbed(plugin.app, targetFile, prepared.outputPath, prepared.embedInNote);
            if (!sync.ok) {
                logger.warn('AudioNarration', `Embed sync after idempotent hit failed: ${sync.error}`);
            }
            void plugin.app.workspace.openLinkText(prepared.outputPath, '', false);
            new Notice(t.settings.audioNarration.notices.alreadyExists, 4000);
            return;
        }
    } finally {
        preflightTicket?.release();
    }

    // Cost confirm
    const modal = new CostConfirmModal(plugin, prepared);
    modal.open();
    const choice = await modal.waitForChoice();
    if (choice === 'cancel') return;
    if (choice === 'settings') {
        // Deep-link to the Audio narration sub-section. Pre-expand parent
        // ('capture-input') + sub ('sub-audio-narration') and scroll the
        // sub-section into view after Obsidian builds the tab.
        const setting = (plugin.app as unknown as {
            setting?: {
                open: () => void;
                openTabById: (id: string) => void;
                activeTab?: { revealSubSection?: (parentId: string, subId: string) => void };
            };
        }).setting;
        try {
            setting?.open();
            setting?.openTabById(plugin.manifest.id);
            setting?.activeTab?.revealSubSection?.('capture-input', 'sub-audio-narration');
        } catch (e) {
            logger.debug('AudioNarration', 'Could not open settings tab', e);
        }
        return;
    }

    // Provider-scoped privacy consent
    const consented = await ensurePrivacyConsent(plugin, prepared.provider.privacyConsentKey);
    if (!consented) {
        new Notice(t.settings.audioNarration.notices.consentDeclined, 4000);
        return;
    }

    // Typed single-flight registry (M2) — runJob guarantees cleanup on
    // any exit (success / error / throw / early return) per audit H8 fix.
    try {
        await plugin.narrationJobs.runJob(jobKey, async (ac) => {
            // First on-screen phase reflects actual first work — synthesis of chunk 1 of N.
            const r = await withProgressResult<NarrateOutcome, NarrationPhase>(
                {
                    plugin,
                    initialPhase: {
                        key: 'narrating',
                        params: { current: 0, total: prepared.cost.chunkCount },
                    },
                    resolvePhase: (p) => {
                        const tmpl = t.progress.audioNarration[p.key];
                        if (!p.params) return tmpl;
                        let out = tmpl;
                        for (const [k, v] of Object.entries(p.params)) {
                            out = out.replace(`{${k}}`, String(v));
                        }
                        return out;
                    },
                    abortController: ac,
                },
                (reporter) => executeNarration(plugin, prepared, { signal: ac.signal, reporter }),
            );

            if (!r.ok) {
                const error = decodeError(r.error);
                // Reporter already fired neutral toast for ABORTED; for other codes
                // it fired the red "Failed: <msg>" toast. mapErrorToNotice may add a
                // follow-up with actionable wording (e.g. NO_API_KEY → settings link).
                const followup = mapErrorToNotice(error, plugin);
                if (followup && error.code === 'NO_API_KEY') {
                    noticeWithSettingsLink(plugin, followup.message);
                } else if (followup && error.code === 'EMBED_FAILED') {
                    new Notice(followup.message, followup.durationMs);
                }
                return;
            }
            showSuccessNotice(plugin, r.value);
        });
    } catch (e) {
        if (e instanceof JobInFlightError) {
            new Notice(t.settings.audioNarration.notices.inFlight, 4000);
            return;
        }
        throw e;
    }
}

/**
 * Open an mp3 file in AudioPlayerModal (speed + skip buttons).
 * Used by the "play-narration" command and the file-menu entry on mp3 files.
 */
export function openAudioPlayer(plugin: AIOrganiserPlugin, file?: TFile): void {
    let target = file;
    if (!target) {
        const active = plugin.app.workspace.getActiveFile();
        if (active && active.extension === 'mp3') {
            target = active;
        }
    }
    if (!target || target.extension !== 'mp3') return;
    new AudioPlayerModal(plugin.app, plugin, target).open();
}

export function registerAudioNarrationCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: NARRATE_NOTE_CMD_ID,
        name: plugin.t.commands.narrateNote,
        icon: 'audio-lines',
        callback: () => { void handleNarrateActiveNote(plugin); },
    });

    plugin.addCommand({
        id: PLAY_NARRATION_CMD_ID,
        name: plugin.t.commands.playNarration,
        icon: 'play-circle',
        checkCallback: (checking: boolean) => {
            const active = plugin.app.workspace.getActiveFile();
            if (!active || active.extension !== 'mp3') return false;
            if (!checking) openAudioPlayer(plugin, active);
            return true;
        },
    });

    // File-menu right-click on a .md or .mp3 file
    plugin.registerEvent(
        plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
            if (!(file instanceof TFile)) return;
            if (file.extension === 'md') {
                menu.addItem((item: MenuItem) => item
                    .setTitle(plugin.t.commands.narrateNote)
                    .setIcon('audio-lines')
                    .onClick(() => { void handleNarrateActiveNote(plugin, file); })
                );
            } else if (file.extension === 'mp3') {
                menu.addItem((item: MenuItem) => item
                    .setTitle(plugin.t.commands.playNarration)
                    .setIcon('play-circle')
                    .onClick(() => openAudioPlayer(plugin, file))
                );
            }
        }),
    );
}
