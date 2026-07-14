/**
 * Audio attach orchestration (plan §7, R1 M3 + R2 H1).
 *
 * Single owner of:
 *  - Platform-aware picker dispatch (desktop → mobile → vault fallback)
 *  - Preview-URL lifecycle (creates `AudioPreviewHandle`s, disposes them on close)
 *  - Vault-persistence wiring (delegates to `importAudioToVault`)
 *
 * The presentational `AudioAttachHelper` invokes coordinator methods via intent
 * callbacks; the coordinator does the orchestration without coupling to the
 * helper's DOM. Hosts (MinutesCreationModal, TranscribeOnlyModal) instantiate
 * the coordinator in `onOpen()` and MUST call `dispose()` in `onClose()` so
 * preview object-URLs are revoked.
 *
 * SRP refinement vs the plan: the plan listed `AudioSourceResolver` and
 * `AudioAttachCoordinator` as separate classes. After implementing
 * `audioImportService`, the resolver collapsed to a one-line delegation —
 * folded into `attachFromImport()` here. Same observable behaviour; one fewer
 * indirection.
 */

import type { App, TFile } from 'obsidian';
import { Platform } from 'obsidian';
import type {
    AudioSource,
    AudioAttachItem,
} from '../components/speakerReviewState';
import {
    pickAudioFromDesktop,
    pickAudioFromMobileWebview,
    pickAudioFromVault,
    isAudioFile,
} from '../utils/AudioSourcePicker';
import { DocumentMultiPickerModal } from '../modals/DocumentMultiPickerModal';
import type { DocumentItem } from '../controllers/DocumentHandlingController';
import type { Translations } from '../../i18n/types';
import { resolvePreview, type AudioPreviewHandle } from './AudioPreviewSource';
import {
    importAudioToVault,
    type ImportedAudio,
    type ImportOptions,
} from '../../services/audio/audioImportService';
import { err, type Result } from '../../core/result';
import { logger } from '../../utils/logger';
import {
    DEEPGRAM_COST_PER_MIN_USD,
    DEEPGRAM_MAX_FILE_BYTES,
    type DiarizationProvider,
    type DiarizationProviderName,
    type DiarizationResult,
} from '../../services/diarization/types';
import { createDeepgramProvider } from '../../services/diarization/deepgramAdapter';
import { createAzureSpeechDiarizationProvider } from '../../services/diarization/azureSpeechDiarizationAdapter';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { assertAllowed } from '../../services/azure/audioProviderPolicy';
import { isAzureSpeechFastTranscriptionConfigured } from '../../services/azure/azureSpeechCredential';
import { getDeepgramApiKey } from '../../services/apiKeyHelpers';
import type AIOrganiserPlugin from '../../main';

/**
 * Outcome of a picker request. `'cancelled'` is distinct from `'failed'`:
 *  - cancelled = user dismissed the picker → no error, no items.
 *  - failed    = a picker threw or the platform offers no usable adapter.
 */
export type PickerOutcome =
    | { kind: 'sources'; sources: AudioSource[] }
    | { kind: 'cancelled' }
    | { kind: 'failed'; reason: string };

export interface CoordinatorOptions {
    /** Vault folder where imported (non-vault) audio is persisted. */
    importTargetFolder: string;
    /**
     * When provided, the vault picker renders via DocumentMultiPickerModal in
     * single-select mode, giving users the "Files in this note (N) · All vault
     * files (M)" radio toggle that documents/agenda/transcript pickers use.
     * When absent, falls back to the legacy FuzzySuggestModal vault picker
     * (in-note files first, 📎 prefix) — kept for backward-compat with hosts
     * that don't have translations on hand.
     */
    translations?: Translations;
    /**
     * Plugin handle for diarization provider selection (azure-audio plan D8):
     * Azure mode + Speech configured → Azure Speech Fast Transcription;
     * private + 'deepgram' → Deepgram. Required for the diarized path
     * (hosts always have it); optional so picker-only usage stays light.
     */
    plugin?: AIOrganiserPlugin;
}

/** Outcome of diarization provider selection (drives modal gating + routing). */
export type DiarizationSelection =
    | { kind: 'available'; providerName: DiarizationProviderName }
    | { kind: 'unavailable'; reason: string };

/**
 * Owns picker dispatch + preview lifecycle. One instance per host modal.
 * Treat as a session-scoped resource; always call `dispose()` on modal close.
 */
export class AudioAttachCoordinator {
    private readonly previewHandles: AudioPreviewHandle[] = [];
    private disposed = false;
    /** Per-modal-session opt-in; modal-instance lifetime. */
    private diarizationOptedIn = false;
    /** How many items the host has currently attached — set via {@link setItemCount}. */
    private itemCount = 0;
    /** Test/DI override — production resolves per-call via policy + settings (D8). */
    private readonly injectedProvider: DiarizationProvider | null;

    constructor(
        private readonly app: App,
        private readonly options: CoordinatorOptions,
        provider?: DiarizationProvider,
    ) {
        this.injectedProvider = provider ?? null;
    }

    /**
     * Select the diarization provider via the central policy (azure-audio D8):
     * Azure mode → in-region azure-speech once configured (strict mode NEVER
     * falls back to a Global-Standard/BYO diarizer); private + 'deepgram' →
     * Deepgram (unchanged). Used for BOTH modal gating and the transcribe call —
     * no Deepgram-shaped key is ever handed to a non-Deepgram provider (H3).
     */
    async resolveDiarizationSelection(): Promise<DiarizationSelection> {
        if (this.injectedProvider) {
            // DI override (tests) — still policy-gated when a plugin is present,
            // so an injected provider cannot bypass strict/compliance mode (D8).
            const plugin = this.options.plugin;
            if (plugin) {
                const allowed = assertAllowed(plugin, { op: 'diarization', providerId: this.injectedProvider.name });
                if (!allowed.ok) return { kind: 'unavailable', reason: allowed.error };
            }
            return { kind: 'available', providerName: this.injectedProvider.name };
        }
        const plugin = this.options.plugin;
        if (!plugin) return { kind: 'unavailable', reason: 'no-plugin' };
        const setting = plugin.settings.audioDiarisationProvider;
        if (setting !== 'deepgram' && setting !== 'azure-speech') {
            return { kind: 'unavailable', reason: 'provider-off' };
        }

        if (isAzureMode(plugin.settings)) {
            // Azure mode: in-region azure-speech first (the compliance point).
            const speechAllowed = assertAllowed(plugin, { op: 'diarization', providerId: 'azure-speech' });
            if (speechAllowed.ok && await isAzureSpeechFastTranscriptionConfigured(plugin)) {
                return { kind: 'available', providerName: 'azure-speech' };
            }
            // Speech not ready → deepgram ONLY when the policy allows it
            // (strict mode refuses — fail-closed, never a silent BYO fallback).
            const dgAllowed = assertAllowed(plugin, { op: 'diarization', providerId: 'deepgram' });
            if (!dgAllowed.ok) return { kind: 'unavailable', reason: 'speech-not-configured' };
            if (setting === 'deepgram' && await safeDeepgramKey(plugin)) {
                return { kind: 'available', providerName: 'deepgram' };
            }
            return { kind: 'unavailable', reason: 'speech-not-configured' };
        }

        // Private/BYO mode.
        const allowed = assertAllowed(plugin, { op: 'diarization', providerId: setting });
        if (!allowed.ok) return { kind: 'unavailable', reason: allowed.error };
        if (setting === 'deepgram') {
            return await safeDeepgramKey(plugin)
                ? { kind: 'available', providerName: 'deepgram' }
                : { kind: 'unavailable', reason: 'no-api-key' };
        }
        return { kind: 'unavailable', reason: 'not-azure-mode' };
    }

    // ============================================================================
    // Source acquisition — one method per user intent
    // ============================================================================

    /**
     * Open the most appropriate device-audio picker for the current platform.
     * Desktop calls the Electron file dialog; mobile calls the webview file
     * input. The mobile path is the core R1 H1 fix that unblocks Pat's P0.
     */
    async requestAttachFromDevice(): Promise<PickerOutcome> {
        this.assertNotDisposed();
        try {
            if (Platform.isMobile) {
                const sources = await pickAudioFromMobileWebview();
                return interpretMaybeSources(sources);
            }
            const sources = await pickAudioFromDesktop();
            return interpretMaybeSources(sources);
        } catch (e) {
            logger.warn('AudioAttachCoordinator', `device picker threw: ${String(e)}`);
            return { kind: 'failed', reason: 'picker-threw' };
        }
    }

    /**
     * Open the vault file picker filtered to audio extensions.
     * Returns at most one source — vault picker is single-select by nature.
     * When `options.translations` is set, routes through the scoped
     * DocumentMultiPickerModal so users see the same "Files in this note ·
     * All vault files" radio toggle as the documents/transcript pickers.
     */
    async requestVaultPick(sourceFile?: TFile | null): Promise<PickerOutcome> {
        this.assertNotDisposed();
        try {
            const source = this.options.translations
                ? await this.pickAudioFromVaultScoped(sourceFile, this.options.translations)
                : await pickAudioFromVault(this.app, sourceFile);
            if (source === null) return { kind: 'cancelled' };
            return { kind: 'sources', sources: [source] };
        } catch (e) {
            logger.warn('AudioAttachCoordinator', `vault picker threw: ${String(e)}`);
            return { kind: 'failed', reason: 'picker-threw' };
        }
    }

    /**
     * Scoped vault picker for audio. Uses DocumentMultiPickerModal in
     * single-select mode with audio extension filter, so users get the
     * same UX as the documents/transcript pickers.
     */
    private pickAudioFromVaultScoped(
        sourceFile: TFile | null | undefined,
        t: Translations,
    ): Promise<AudioSource | null> {
        return new Promise<AudioSource | null>((resolve) => {
            const audioFiles = this.app.vault.getFiles()
                .filter(isAudioFile)
                .sort((a, b) => b.stat.mtime - a.stat.mtime);
            if (audioFiles.length === 0) {
                resolve(null);
                return;
            }
            const items: DocumentItem[] = audioFiles.map((f) => ({
                id: f.path,
                name: f.name,
                path: f.path,
                isExternal: false,
                file: f,
                truncationChoice: 'full' as const,
                charCount: 0,
                isProcessing: false,
                sectionId: 'general',
            }));
            let settled = false;
            const settle = (v: AudioSource | null): void => {
                if (settled) return;
                settled = true;
                resolve(v);
            };
            const picker = new DocumentMultiPickerModal(this.app, {
                items,
                t,
                app: this.app,
                sourceFile: sourceFile ?? undefined,
                singleSelect: true,
                title: 'Pick an audio file',
                description: 'Audio files in this note are shown first; switch to "All vault files" to browse the rest.',
                confirmLabel: 'Attach',
                onConfirm: (selected) => {
                    const file = selected[0]?.item.file ?? null;
                    settle(file ? { kind: 'vault', file } : null);
                },
            });
            const origClose = picker.onClose.bind(picker);
            picker.onClose = (): void => {
                origClose();
                window.setTimeout(() => settle(null), 50);
            };
            picker.open();
        });
    }

    // ============================================================================
    // Vault persistence — turns AudioSource into a TFile ready for transcription
    // ============================================================================

    /**
     * Persist a source to the vault. Vault sources pass through unchanged;
     * non-vault sources are written to `options.importTargetFolder` with
     * collision-safe filenames. Returns `ImportedAudio` so callers can build
     * an `AudioAttachItem` with the resulting `TFile`.
     *
     * `signal` lets long-running writes (large desktop files) be cancelled
     * when the host modal closes mid-import.
     */
    importToVault(source: AudioSource, signal?: AbortSignal): Promise<Result<ImportedAudio>> {
        this.assertNotDisposed();
        const opts: ImportOptions = {
            targetFolder: this.options.importTargetFolder,
            signal,
        };
        return importAudioToVault(this.app, source, opts);
    }

    /**
     * Build an `AudioAttachItem` from a freshly-imported `TFile`. Helpful when
     * the host wants to push the item straight into modal state without
     * threading `ImportedAudio` through its own state machine.
     */
    buildAttachItem(imported: ImportedAudio): AudioAttachItem {
        const source: AudioSource = { kind: 'vault', file: imported.file };
        return {
            source,
            displayName: imported.originalName,
            itemState: 'pending',
        };
    }

    // ============================================================================
    // Preview lifecycle — coordinator owns object-URL disposal
    // ============================================================================

    /**
     * Resolve a source to a playable `<audio>` URL. The coordinator retains
     * the handle so its `dispose()` is called when the modal closes.
     * Idempotent w.r.t. multiple `attachPreview()` calls on the same source —
     * a new handle is created each time (different `<audio>` elements may
     * need separate URLs for browser caching reasons).
     */
    attachPreview(source: AudioSource): AudioPreviewHandle {
        this.assertNotDisposed();
        const handle = resolvePreview(source, this.app);
        this.previewHandles.push(handle);
        return handle;
    }

    // ============================================================================
    // Resource disposal — MUST be called from Modal.onClose()
    // ============================================================================

    /** Revokes every preview URL the coordinator created. Idempotent. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const handle of this.previewHandles) {
            try {
                handle.dispose();
            } catch (e) {
                logger.warn('AudioAttachCoordinator', `preview dispose threw: ${String(e)}`);
            }
        }
        this.previewHandles.length = 0;
    }

    /**
     * Test/debug hook — number of preview handles currently retained. Not
     * intended for production callers.
     */
    getActivePreviewCount(): number {
        return this.previewHandles.length;
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new Error('AudioAttachCoordinator: instance has been disposed');
        }
    }

    // ============================================================================
    // Diarization opt-in (plan §1.5 R1 H3 + Gemini G3 wiring)
    // ============================================================================

    /** Set the modal-session diarization opt-in. */
    setDiarizationOptIn(value: boolean): void {
        this.diarizationOptedIn = value;
    }

    shouldUseDiarization(): boolean {
        return this.diarizationOptedIn;
    }

    /**
     * Notify the coordinator how many items the host has attached. Used by
     * {@link canTranscribeNow} to enforce the single-file constraint when
     * diarization is enabled (R3 H1).
     */
    setItemCount(n: number): void {
        this.itemCount = n;
    }

    /**
     * Orchestration-level invariant for whether the host can call transcribe
     * right now (R4 H2). Hosts use this to drive button state + tooltip.
     */
    canTranscribeNow(): { allowed: true } | { allowed: false; reason: 'multi-file-diarization' | 'no-items' } {
        if (this.itemCount === 0) return { allowed: false, reason: 'no-items' };
        if (this.diarizationOptedIn && this.itemCount > 1) {
            return { allowed: false, reason: 'multi-file-diarization' };
        }
        return { allowed: true };
    }

    /**
     * Cheaply-available size hint for a source. Returns null when the size
     * isn't knowable without doing an import (webview-blob occasionally lacks
     * `Blob.size` in older Electron versions — null routes the host to the
     * `costUnknown` i18n path per G2-H1).
     */
    getUpfrontSourceSize(source: AudioSource): number | null {
        switch (source.kind) {
            case 'vault':
                return source.file.stat?.size ?? null;
            case 'webview-blob':
            case 'recorder':
                return typeof source.blob.size === 'number' ? source.blob.size : null;
            case 'desktop-path':
                // Electron File from showOpenDialog doesn't carry size; we
                // discover it on import. Conservative: return null.
                return null;
        }
    }

    /** Pure cost estimate (dollars) from file size at 128kbps baseline. */
    estimateAudioCostUsd(
        fileSizeBytes: number,
        costPerMin = DEEPGRAM_COST_PER_MIN_USD,
    ): number {
        const estimatedMins = (fileSizeBytes * 8) / 128_000 / 60;
        return estimatedMins * costPerMin;
    }

    /**
     * Format a cost number as a UI string. Always 2 decimals; `~$0.01` floor
     * so users don't see `~$0.00` and assume "free" (R3 M2 + G6).
     */
    formatCostPreview(costUsd: number): string {
        if (!Number.isFinite(costUsd) || costUsd <= 0) return '~$0.01';
        if (costUsd < 0.01) return '~$0.01';
        return `~$${costUsd.toFixed(2)}`;
    }

    /**
     * Run the full diarized path: import source → size guard → read bytes →
     * provider call. Single entry point used by both Minutes and TranscribeOnly
     * modals; mirrors the Whisper-side `transcribeAudioWithFullWorkflow`
     * contract but yields a `DiarizationResult` instead of a raw transcript.
     */
    async transcribeDiarized(
        item: AudioAttachItem,
        signal?: AbortSignal,
    ): Promise<Result<DiarizationResult>> {
        this.assertNotDisposed();

        // Pre-import size guard (R4 H1) — fail fast when size is known
        const upfront = this.getUpfrontSourceSize(item.source);
        if (upfront !== null && upfront > DEEPGRAM_MAX_FILE_BYTES) {
            return err(`file-too-large:${upfront}:${DEEPGRAM_MAX_FILE_BYTES}`);
        }

        const selection = await this.resolveDiarizationSelection();
        if (selection.kind === 'unavailable') {
            return err(`diarization-unavailable:${selection.reason}`);
        }

        const imported = await this.importToVault(item.source, signal);
        if (!imported.ok) return err(`import-failed:${imported.error}`);

        // Post-import size guard (R3 H2 second-line) — webview-blob case
        const fileSize = imported.value.file.stat?.size ?? 0;
        if (fileSize > DEEPGRAM_MAX_FILE_BYTES) {
            return err(`file-too-large:${fileSize}:${DEEPGRAM_MAX_FILE_BYTES}`);
        }

        const bytes = await this.app.vault.readBinary(imported.value.file);

        const provider = this.injectedProvider ?? (selection.providerName === 'azure-speech'
            // plugin is non-null here: a selection without an injected provider
            // can only come from the plugin-backed resolution path above.
            ? createAzureSpeechDiarizationProvider(this.options.plugin as AIOrganiserPlugin)
            : createDeepgramProvider(this.options.plugin as AIOrganiserPlugin));

        return provider.transcribeWithDiarization(this.app, bytes, {
            signal,
            filename: imported.value.file.name,
        });
    }
}

/** Never-throws Deepgram key probe (availability only — value not retained). */
async function safeDeepgramKey(plugin: AIOrganiserPlugin): Promise<boolean> {
    try {
        return !!(await getDeepgramApiKey(plugin));
    } catch {
        return false;
    }
}

// ============================================================================
// Helpers
// ============================================================================

function interpretMaybeSources(sources: AudioSource[] | null): PickerOutcome {
    if (sources === null) return { kind: 'failed', reason: 'platform-unavailable' };
    if (sources.length === 0) return { kind: 'cancelled' };
    return { kind: 'sources', sources };
}
