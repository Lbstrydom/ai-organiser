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

import type { App } from 'obsidian';
import { Platform } from 'obsidian';
import type {
    AudioSource,
    AudioAttachItem,
} from '../components/speakerReviewState';
import {
    pickAudioFromDesktop,
    pickAudioFromMobileWebview,
    pickAudioFromVault,
} from '../utils/AudioSourcePicker';
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
    type DiarizationResult,
} from '../../services/diarization/types';
import { deepgramAdapter } from '../../services/diarization/deepgramAdapter';

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
}

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
    private readonly provider: DiarizationProvider;

    constructor(
        private readonly app: App,
        private readonly options: CoordinatorOptions,
        provider?: DiarizationProvider,
    ) {
        this.provider = provider ?? deepgramAdapter;
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
     */
    async requestVaultPick(): Promise<PickerOutcome> {
        this.assertNotDisposed();
        try {
            const source = await pickAudioFromVault(this.app);
            if (source === null) return { kind: 'cancelled' };
            return { kind: 'sources', sources: [source] };
        } catch (e) {
            logger.warn('AudioAttachCoordinator', `vault picker threw: ${String(e)}`);
            return { kind: 'failed', reason: 'picker-threw' };
        }
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
        apiKey: string,
        signal?: AbortSignal,
    ): Promise<Result<DiarizationResult>> {
        this.assertNotDisposed();

        // Pre-import size guard (R4 H1) — fail fast when size is known
        const upfront = this.getUpfrontSourceSize(item.source);
        if (upfront !== null && upfront > DEEPGRAM_MAX_FILE_BYTES) {
            return err(`file-too-large:${upfront}:${DEEPGRAM_MAX_FILE_BYTES}`);
        }

        const imported = await this.importToVault(item.source, signal);
        if (!imported.ok) return err(`import-failed:${imported.error}`);

        // Post-import size guard (R3 H2 second-line) — webview-blob case
        const fileSize = imported.value.file.stat?.size ?? 0;
        if (fileSize > DEEPGRAM_MAX_FILE_BYTES) {
            return err(`file-too-large:${fileSize}:${DEEPGRAM_MAX_FILE_BYTES}`);
        }

        const bytes = await this.app.vault.readBinary(imported.value.file);

        return this.provider.transcribeWithDiarization(this.app, bytes, apiKey, {
            signal,
            filename: imported.value.file.name,
        });
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
