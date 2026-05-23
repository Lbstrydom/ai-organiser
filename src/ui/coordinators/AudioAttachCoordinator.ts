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
import type { Result } from '../../core/result';
import { logger } from '../../utils/logger';

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

    constructor(
        private readonly app: App,
        private readonly options: CoordinatorOptions
    ) {}

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
}

// ============================================================================
// Helpers
// ============================================================================

function interpretMaybeSources(sources: AudioSource[] | null): PickerOutcome {
    if (sources === null) return { kind: 'failed', reason: 'platform-unavailable' };
    if (sources.length === 0) return { kind: 'cancelled' };
    return { kind: 'sources', sources };
}
