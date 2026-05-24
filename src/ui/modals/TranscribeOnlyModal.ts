/**
 * TranscribeOnlyModal (plan F3).
 *
 * Slim, single-purpose modal: attach audio → transcribe → confirm speakers →
 * save as a vault note with `type: transcript` frontmatter. Distinct from
 * MinutesCreationModal because the user might want JUST a labelled transcript
 * (no meeting metadata, no minutes generation, no context docs / dictionary).
 *
 * Reuses by composition (not duplication):
 *   - AudioAttachCoordinator + AudioAttachHelper for the trio + import
 *   - labelSpeakersTimed + SpeakerReviewPanel for speaker confirmation
 *   - writeTranscriptNote (F3a) for the persistence contract
 *
 * Pat persona-test acceptance: with this modal + the new transcribe-audio
 * command, Pat can type "transcribe" into the picker, get a hit, and end up
 * with a labelled-transcript .md note in one focused flow — no metadata
 * gymnastics required.
 */

import { App, Modal, Notice, Platform, TFile, setIcon, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { listen } from '../utils/domUtils';
import { AudioAttachCoordinator } from '../coordinators/AudioAttachCoordinator';
import {
    renderAudioAttach,
    type AudioAttachHandle,
} from '../components/AudioAttachHelper';
import type {
    AudioAttachViewState,
    SpeakerMapping,
    SpeakerReviewState,
} from '../components/speakerReviewState';
import {
    renderSpeakerReview,
    type SpeakerReviewHandle,
} from '../components/SpeakerReviewPanel';
import {
    labelSpeakersTimed,
    transcriptionResultToTimedTranscript,
} from '../../services/speakerLabellingService';
import type { LabelledTimedTranscript } from '../../services/transcriptTypes';
import { writeTranscriptNote, type TranscriptNote } from '../../services/transcriptNoteService';
import { getTranscriptOutputFullPath } from '../../core/settings';
import { ensureFolderExists, getAvailableFilePath, sanitizeFileName } from '../../utils/minutesUtils';
import { isRecordingSupported } from '../../services/audioRecordingService';
import { transcribeAudioWithFullWorkflow } from '../../services/audioTranscriptionService';
import { getAudioTranscriptionApiKey, getDeepgramApiKey } from '../../services/apiKeyHelpers';
import { DiarizationPrivacyModal } from './DiarizationPrivacyModal';
import { DEEPGRAM_LARGE_FILE_WARN_BYTES } from '../../services/diarization/types';
import type { DiarizationResult } from '../../services/diarization/types';

export class TranscribeOnlyModal extends Modal {
    private readonly plugin: AIOrganiserPlugin;
    private coordinator: AudioAttachCoordinator | null = null;
    private audioHandle: AudioAttachHandle | null = null;
    private speakerHandle: SpeakerReviewHandle | null = null;
    private speakerSlotEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private saveBtnEl: HTMLButtonElement | null = null;
    private cleanups: Array<() => void> = [];

    private audioFile: TFile | null = null;
    private audioDisplayName: string = '';
    private labelled: LabelledTimedTranscript | null = null;
    private speakerReview: SpeakerReviewState = { kind: 'not-required' };
    private outputFolder: string;
    /** Async-resolved Deepgram API key (null = not configured / not yet checked) */
    private deepgramKey: string | null = null;
    /** Used when async key resolution races against onClose() */
    private isOpenFlag = false;
    /** Whether transcription is currently in flight (drives toggle.disabled). */
    private transcribing = false;
    /** DiarizationResult from the diarized path — used to write provider/cost frontmatter. */
    private diarizationResult: DiarizationResult | null = null;
    /** Modal-scoped opt-in mirror — survives coordinator recreation (parity with Minutes modal fix). */
    private diarizationOptedIn = false;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
        this.outputFolder = getTranscriptOutputFullPath(plugin.settings);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-transcribe-only-modal');

        const tMin = this.plugin.t.minutes;

        // Header
        const header = contentEl.createDiv({ cls: 'ai-organiser-transcribe-only-header' });
        const headerIcon = header.createSpan();
        setIcon(headerIcon, 'mic');
        header.createEl('h2', { text: tMin.transcribeOnlyTitle || 'Transcribe audio' });

        // Description
        contentEl.createEl('p', {
            text: tMin.transcribeOnlyDescription ||
                'Attach an audio file and produce a speaker-labelled transcript note.',
            cls: 'ai-organiser-transcribe-only-desc ai-organiser-text-muted',
        });

        // Coordinator — same one used by MinutesCreationModal. Imports go to
        // AI-Organiser/Imports/ to stay consistent with the Minutes flow.
        this.coordinator = new AudioAttachCoordinator(this.app, {
            importTargetFolder: 'AI-Organiser/Imports',
        });

        // Audio attach trio.
        const attachSlot = contentEl.createDiv({ cls: 'ai-organiser-transcribe-only-attach' });
        this.renderAttach(attachSlot);

        // Speaker review slot — populated after transcription completes.
        this.speakerSlotEl = contentEl.createDiv({ cls: 'ai-organiser-transcribe-only-speaker-slot' });

        // Status line + Save/Cancel buttons.
        const footer = contentEl.createDiv({ cls: 'ai-organiser-transcribe-only-footer' });
        this.statusEl = footer.createDiv({
            cls: 'ai-organiser-transcribe-only-status ai-organiser-text-muted',
        });

        const actions = footer.createDiv({ cls: 'ai-organiser-transcribe-only-actions' });
        const cancelBtn = actions.createEl('button', {
            text: tMin.transcribeOnlyCancelButton || 'Cancel',
        });
        this.cleanups.push(listen(cancelBtn, 'click', () => this.close()));

        this.saveBtnEl = actions.createEl('button', {
            text: tMin.transcribeOnlySaveButton || 'Save transcript',
            cls: 'mod-cta',
        });
        this.cleanups.push(listen(this.saveBtnEl, 'click', () => void this.handleSave()));
        this.refreshSaveButtonGate();

        this.isOpenFlag = true;
        // Async-resolve Deepgram key; re-render the helper region once known
        // so the checkbox shows up (or stays hidden) without flicker.
        void this.resolveDeepgramKeyAndRefresh();
    }

    onClose(): void {
        this.isOpenFlag = false;
        this.speakerHandle?.destroy();
        this.speakerHandle = null;
        this.audioHandle?.destroy();
        this.audioHandle = null;
        this.coordinator?.dispose();
        this.coordinator = null;
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }

    // ============================================================================
    // Audio attach
    // ============================================================================

    private renderAttach(container: HTMLElement): void {
        this.audioHandle?.destroy();
        // Sync coordinator's item-count for the multi-file constraint check (R3 H1)
        if (this.coordinator) this.coordinator.setItemCount(this.audioFile ? 1 : 0);
        this.audioHandle = renderAudioAttach(container, {
            state: this.deriveAttachViewState(),
            allowRecord: isRecordingSupported(),
            t: this.plugin.t,
            diarizationToggle: this.buildDiarizationToggleOptions(),
            onAttachIntent: () => void this.handleAttachIntent(),
            onPickVaultIntent: () => void this.handlePickVaultIntent(),
            onRecordIntent: () => {
                // Recording in TranscribeOnly would re-implement the recorder
                // flow with this modal as the host — out of scope for v1.
                // Users who want to record can use the existing record-audio
                // command and then drag the resulting file in.
                new Notice(this.plugin.t.minutes.transcribeOnlyAttachFirst || 'Recording from this modal is not yet supported');
            },
            // Auto-detect prompt isn't relevant in TranscribeOnly — there's no
            // active-note context to detect from. Callbacks are no-ops.
            onDetectedAccept: () => {},
            onDetectedDismiss: () => {},
            onReplaceIntent: () => void this.handleAttachIntent(),
            onTranscribeIntent: () => void this.handleTranscribe(),
            onAbortIntent: () => {},
            onRetryIntent: () => void this.handleAttachIntent(),
        });
    }

    private deriveAttachViewState(): AudioAttachViewState {
        if (!this.audioFile) return { kind: 'empty' };
        const item = {
            source: { kind: 'vault' as const, file: this.audioFile },
            displayName: this.audioDisplayName,
            itemState: 'pending' as const,
        };
        return { kind: 'attached', items: [item] };
    }

    private async handleAttachIntent(): Promise<void> {
        if (!this.coordinator) return;
        const outcome = await this.coordinator.requestAttachFromDevice();
        await this.handlePickerOutcome(outcome);
    }

    private async handlePickVaultIntent(): Promise<void> {
        if (!this.coordinator) return;
        const outcome = await this.coordinator.requestVaultPick();
        await this.handlePickerOutcome(outcome);
    }

    private async handlePickerOutcome(
        outcome: Awaited<ReturnType<AudioAttachCoordinator['requestAttachFromDevice']>>
    ): Promise<void> {
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'failed') {
            new Notice(`Audio picker failed: ${outcome.reason}`);
            return;
        }
        if (!this.coordinator) return;
        // Take the first source — TranscribeOnly is single-file by design.
        const imported = await this.coordinator.importToVault(outcome.sources[0]);
        if (!imported.ok) {
            new Notice(`Audio import failed: ${imported.error}`);
            return;
        }
        this.audioFile = imported.value.file;
        this.audioDisplayName = imported.value.originalName;
        // Reset any previous transcription state.
        this.labelled = null;
        this.speakerReview = { kind: 'not-required' };
        this.speakerHandle?.destroy();
        this.speakerHandle = null;
        if (this.speakerSlotEl) this.speakerSlotEl.empty();
        this.audioHandle?.rerender(this.deriveAttachViewState());
        this.refreshSaveButtonGate();
    }

    // ============================================================================
    // Transcription
    // ============================================================================

    private async handleTranscribe(): Promise<void> {
        if (!this.audioFile) {
            new Notice(this.plugin.t.minutes.transcribeOnlyAttachFirst || 'Attach an audio file first');
            return;
        }

        // Branch: diarized path (Deepgram) vs default Whisper path.
        if (this.coordinator?.shouldUseDiarization()) {
            await this.handleTranscribeDiarized();
            return;
        }

        await this.handleTranscribeWhisper();
    }

    private async handleTranscribeWhisper(): Promise<void> {
        if (!this.audioFile) return;
        const apiKeyResult = await getAudioTranscriptionApiKey(this.plugin);
        if (!apiKeyResult) {
            new Notice(this.plugin.t.minutes.noTranscriptionProvider ||
                'Configure OpenAI or Groq API key for transcription');
            return;
        }
        this.setTranscribing(true);
        this.setStatus(this.plugin.t.minutes.transcribing || 'Transcribing…');

        try {
            const result = await transcribeAudioWithFullWorkflow(
                this.app,
                this.audioFile,
                {
                    provider: apiKeyResult.provider,
                    apiKey: apiKeyResult.key,
                    language: undefined,
                },
                (progress) => this.setStatus(progress.message)
            );
            if (!result.success || !result.transcript) {
                throw new Error(result.error || 'Transcription failed');
            }
            const timed = transcriptionResultToTimedTranscript(result, result.language || 'und');
            this.labelled = await labelSpeakersTimed(this.plugin, timed, []);
            this.diarizationResult = null;
            this.transitionSpeakerReview();
            this.refreshSaveButtonGate();
            this.setStatus(this.plugin.t.minutes.transcriptionComplete || 'Transcription complete');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('TranscribeOnly', `transcription threw: ${message}`);
            new Notice(`${this.plugin.t.minutes.transcriptionFailed || 'Transcription failed'}: ${message}`);
            this.setStatus(this.plugin.t.minutes.transcriptionFailed || 'Transcription failed');
        } finally {
            this.setTranscribing(false);
        }
    }

    private async handleTranscribeDiarized(): Promise<void> {
        if (!this.audioFile || !this.coordinator) return;
        if (!this.deepgramKey) {
            new Notice(this.plugin.t.diarization.failedNotice.replace('{error}', 'no-api-key'));
            return;
        }
        this.setTranscribing(true);
        this.setStatus(this.plugin.t.minutes.transcribing || 'Transcribing…');

        const item = {
            source: { kind: 'vault' as const, file: this.audioFile },
            displayName: this.audioDisplayName,
            itemState: 'pending' as const,
        };
        const result = await this.coordinator.transcribeDiarized(item, this.deepgramKey);

        if (!result.ok) {
            const msg = this.plugin.t.diarization.failedNotice.replace('{error}', result.error);
            new Notice(msg, 6000);
            this.setStatus(this.plugin.t.minutes.transcriptionFailed || 'Transcription failed');
            this.setTranscribing(false);
            return;
        }

        this.diarizationResult = result.value;
        this.labelled = result.value.labelled;
        this.transitionSpeakerReview();
        this.refreshSaveButtonGate();
        this.setStatus(this.plugin.t.minutes.transcriptionComplete || 'Transcription complete');
        this.setTranscribing(false);
    }

    private setTranscribing(value: boolean): void {
        this.transcribing = value;
        this.rerenderAttach();
    }

    private setStatus(message: string): void {
        if (this.statusEl) this.statusEl.setText(message);
    }

    private transitionSpeakerReview(): void {
        if (!this.labelled) return;
        const detectedLabels = this.labelled.speakers;
        if (detectedLabels.length < 2) {
            this.speakerReview = { kind: 'not-required' };
        } else {
            const detected = detectedLabels.map((label) => {
                const first = this.labelled!.segments.find((s) => s.speaker === label);
                return {
                    label,
                    firstUtteranceStartMs:
                        this.labelled!.timestampSource === 'whisper-verbose-json' ? first?.startMs : undefined,
                    firstUtteranceText: first?.text ?? '',
                    occurrenceCount: this.labelled!.segments.filter((s) => s.speaker === label).length,
                };
            });
            this.speakerReview = { kind: 'pending', detected };
        }
        this.renderSpeakerReview();
    }

    private renderSpeakerReview(): void {
        if (!this.speakerSlotEl) return;
        this.speakerHandle?.destroy();
        this.speakerSlotEl.empty();
        if (this.speakerReview.kind === 'not-required') return;

        const previewHandle =
            this.coordinator && this.audioFile
                ? this.coordinator.attachPreview({ kind: 'vault', file: this.audioFile })
                : null;
        const timestampsAvailable =
            (this.labelled?.timestampSource ?? 'none') === 'whisper-verbose-json';

        this.speakerHandle = renderSpeakerReview(this.speakerSlotEl, {
            state: this.speakerReview,
            participants: [],
            preview: previewHandle,
            timestampsAvailable,
            t: this.plugin.t,
            onConfirm: (mapping: SpeakerMapping) => this.handleSpeakerConfirm(mapping),
            onSkip: () => this.handleSpeakerSkip(),
        });
    }

    private handleSpeakerConfirm(mapping: SpeakerMapping): void {
        if (this.speakerReview.kind !== 'pending') return;
        this.speakerReview = {
            kind: 'confirmed',
            detected: this.speakerReview.detected,
            mapping,
        };
        this.renderSpeakerReview();
        this.refreshSaveButtonGate();
    }

    private handleSpeakerSkip(): void {
        const detected = this.speakerReview.kind === 'pending' ? this.speakerReview.detected : [];
        this.speakerReview = { kind: 'skipped', detected, reason: 'user-skip' };
        this.renderSpeakerReview();
        this.refreshSaveButtonGate();
    }

    // ============================================================================
    // Save
    // ============================================================================

    private refreshSaveButtonGate(): void {
        if (!this.saveBtnEl) return;
        // Save is enabled when we have a labelled transcript AND speaker review
        // is in a terminal state (confirmed / skipped / not-required).
        const ready =
            this.labelled !== null &&
            (this.speakerReview.kind === 'confirmed' ||
                this.speakerReview.kind === 'skipped' ||
                this.speakerReview.kind === 'not-required');
        this.saveBtnEl.disabled = !ready;
    }

    private async handleSave(): Promise<void> {
        if (!this.labelled || !this.audioFile) {
            new Notice(this.plugin.t.minutes.transcribeOnlyTranscribeFirst || 'Transcribe before saving');
            return;
        }

        const note = this.buildTranscriptNote(this.audioFile, this.labelled);
        let savedPath: string;
        try {
            const md = await writeTranscriptNote(note);
            await ensureFolderExists(this.app.vault, normalizePath(this.outputFolder));
            const baseName = sanitizeFileName(this.deriveFilename());
            const targetPath = await getAvailableFilePath(this.app.vault, this.outputFolder, `${baseName}.md`);
            await this.app.vault.create(targetPath, md);
            savedPath = targetPath;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('TranscribeOnly', `save failed: ${message}`);
            new Notice(`Save failed: ${message}`);
            return;
        }

        const noticeTpl = this.plugin.t.minutes.transcribeOnlySavedNotice || 'Transcript saved: {path}';
        new Notice(noticeTpl.replace('{path}', savedPath), 4000);
        if (this.plugin.t.minutes.transcribeOnlyFollowUpHint) {
            new Notice(this.plugin.t.minutes.transcribeOnlyFollowUpHint, 6000);
        }

        // Open the newly-saved transcript so the user can see what they got.
        const file = this.app.vault.getAbstractFileByPath(savedPath);
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf().openFile(file);
        }
        this.close();
    }

    /** Build the in-memory `TranscriptNote` from current modal state. */
    private buildTranscriptNote(audio: TFile, labelled: LabelledTimedTranscript): TranscriptNote {
        const mapping =
            this.speakerReview.kind === 'confirmed' ? this.speakerReview.mapping : {};
        const verified = this.speakerReview.kind === 'confirmed';
        const status: TranscriptNote['frontmatter']['speaker_detection_status'] =
            this.speakerReview.kind === 'confirmed' ? 'detected' :
            this.speakerReview.kind === 'skipped' ? 'skipped' :
            this.speakerReview.kind === 'failed' ? 'failed' :
            'not-required';
        const dia = this.diarizationResult;
        return {
            frontmatter: {
                type: 'transcript',
                audio: audio.path,
                language: labelled.languageCode,
                duration_seconds: Math.round((labelled.durationMs ?? 0) / 1000),
                speakers: mapping,
                speakers_verified: verified,
                speaker_detection_status: status,
                timestamp_source: labelled.timestampSource,
                created_at: new Date().toISOString(),
                ...(dia
                    ? {
                          diarization_provider: dia.provider,
                          ...(dia.actualCostUsd !== null
                              ? { diarization_cost_usd: dia.actualCostUsd }
                              : {}),
                          diarization_language: dia.detectedLanguage,
                      }
                    : {}),
            },
            body: labelled,
        };
    }

    /**
     * Derive a filename for the saved transcript. Uses the source audio's
     * basename so the user can spot which audio it was for. Date suffix
     * prevents collisions when multiple transcripts of the same audio exist.
     */
    private deriveFilename(): string {
        const audioName = this.audioFile?.basename || 'audio';
        const date = new Date().toISOString().slice(0, 10);
        return `${audioName} transcript ${date}`;
    }

    // ============================================================================
    // Diarization opt-in (plan §1.5 + Gemini G3)
    // ============================================================================

    /**
     * Async key resolve on modal open. Re-renders the attach region once the
     * key is known so the checkbox shows up without flicker. Guarded against
     * onClose racing the resolution.
     */
    private async resolveDeepgramKeyAndRefresh(): Promise<void> {
        try {
            this.deepgramKey = await getDeepgramApiKey(this.plugin);
        } catch {
            this.deepgramKey = null;
        }
        if (!this.isOpenFlag) return;
        // Re-render the attach region so the diarizationToggle slot reflects the resolved key.
        const attachSlot = this.contentEl.querySelector<HTMLElement>('.ai-organiser-transcribe-only-attach');
        if (attachSlot) this.renderAttach(attachSlot);
    }

    /**
     * Build the diarizationToggle options for the helper. Returns undefined
     * (no checkbox at all) on mobile, when provider !== 'deepgram', or when
     * no key is configured.
     */
    private buildDiarizationToggleOptions() {
        if (Platform.isMobile) return undefined;
        if (this.plugin.settings.audioDiarisationProvider !== 'deepgram') return undefined;
        if (!this.deepgramKey) return undefined;
        if (!this.coordinator) return undefined;

        const checked = this.coordinator.shouldUseDiarization();
        const costPreviewText = this.computeCostPreviewText();

        return {
            visible: true,
            checked,
            disabled: this.transcribing,
            costPreviewText,
            onChange: (next: boolean) => this.handleDiarizationToggleChange(next),
        };
    }

    private computeCostPreviewText(): string | null {
        if (!this.coordinator || !this.audioFile) return null;
        const upfront = this.coordinator.getUpfrontSourceSize({ kind: 'vault', file: this.audioFile });
        const tDia = this.plugin.t.diarization;
        if (upfront === null || upfront <= 0) return tDia.costUnknown;
        const usd = this.coordinator.estimateAudioCostUsd(upfront);
        const formatted = this.coordinator.formatCostPreview(usd);
        return tDia.costPreview.replace('{cost}', formatted);
    }

    private handleDiarizationToggleChange(next: boolean): void {
        if (!this.coordinator) return;

        if (
            next === true
            && !this.plugin.diarizationDisclosureShownThisSession
        ) {
            // Disclosure modal — only on transition unchecked → checked.
            DiarizationPrivacyModal.openOnce(this.app, this.plugin.t, (accepted) => {
                if (accepted) {
                    this.plugin.diarizationDisclosureShownThisSession = true;
                    this.diarizationOptedIn = true;
                    this.coordinator!.setDiarizationOptIn(true);
                    this.maybeWarnLargeFileSync();
                } else {
                    // Rejection leaves disclosureShown=false so user can retrigger.
                    this.diarizationOptedIn = false;
                    this.coordinator!.setDiarizationOptIn(false);
                }
                this.rerenderAttach();
            });
            return;
        }

        this.diarizationOptedIn = next;
        this.coordinator.setDiarizationOptIn(next);
        if (next) this.maybeWarnLargeFileSync();
        this.rerenderAttach();
    }

    private maybeWarnLargeFileSync(): void {
        if (this.plugin.diarizationLargeFileWarningShownThisSession) return;
        if (!this.audioFile || !this.coordinator) return;
        const size = this.audioFile.stat?.size ?? 0;
        if (size < DEEPGRAM_LARGE_FILE_WARN_BYTES) return;
        this.plugin.diarizationLargeFileWarningShownThisSession = true;
        const sizeMB = Math.round(size / (1024 * 1024));
        const msg = this.plugin.t.diarization.largeFileSyncWarning.replace('{sizeMB}', String(sizeMB));
        new Notice(msg, 8000);
    }

    private rerenderAttach(): void {
        const attachSlot = this.contentEl.querySelector<HTMLElement>('.ai-organiser-transcribe-only-attach');
        if (attachSlot) this.renderAttach(attachSlot);
    }
}

/** Re-exported so commands can construct the modal without circular imports. */
export type { LabelledTimedTranscript };
// Keep happy-dom + Platform-imported even though not directly referenced — the
// modal interacts with mobile-specific behaviour via the underlying coordinator
// + recorder helpers, which need these in their own modules.
void Platform;
