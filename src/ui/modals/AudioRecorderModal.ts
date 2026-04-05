/**
 * Audio Recorder Modal
 * Record audio directly within Obsidian with auto-transcription support.
 * Supports standalone, minutes, and multi-source modes.
 */

import { App, Modal, Notice, Platform, TFile, setIcon } from 'obsidian';
import { logger } from '../../utils/logger';
import type AIOrganiserPlugin from '../../main';
import {
    AudioRecordingService,
    isRecordingSupported,
    selectMime,
    getMaxRecordingMinutes,
    RECORDING_BITRATES,
    type RecordingQuality
} from '../../services/audioRecordingService';
import { MAX_FILE_SIZE_BYTES, transcribeAudio, formatFileSize } from '../../services/audioTranscriptionService';
import { getAudioTranscriptionApiKey } from '../../services/apiKeyHelpers';
import { ensureFolderExists, sanitizeFileName, getAvailableFilePath } from '../../utils/minutesUtils';
import { insertAtCursor } from '../../utils/editorUtils';
import { DEFAULT_RECORDING_FOLDER } from '../../core/constants';
import { getOutputSubfolderPath } from '../../core/settings';
import { listen } from '../utils/domUtils';

export interface RecorderOptions {
    mode: 'standalone' | 'minutes' | 'multi-source';
    onComplete?: (result: RecordingResult) => void;
    transcriptionLanguage?: string;
}

export interface RecordingResult {
    file: TFile;
    transcript?: string;
    duration: number;
}

type RecorderState = 'idle' | 'recording' | 'stopped' | 'saving' | 'transcribing' | 'post-save' | 'done';

export class AudioRecorderModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private options: RecorderOptions;
    private recorder: AudioRecordingService;
    private state: RecorderState = 'idle';
    private timerInterval: ReturnType<typeof setInterval> | null = null;
    private blob: Blob | null = null;
    private audioUrl: string | null = null;
    private actionFired = false;
    private cleanups: (() => void)[] = [];

    // UI elements
    private timerEl: HTMLElement | null = null;
    private sizeEl: HTMLElement | null = null;
    private controlsEl: HTMLElement | null = null;
    private outputEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private autoTranscribeCheckbox: HTMLInputElement | null = null;
    private embedCheckbox: HTMLInputElement | null = null;
    private outputRadios: HTMLInputElement[] = [];
    private filenameInput: HTMLInputElement | null = null;

    constructor(app: App, plugin: AIOrganiserPlugin, options: RecorderOptions) {
        super(app);
        this.plugin = plugin;
        this.options = options;
        this.recorder = new AudioRecordingService();
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-audio-recorder-modal');

        const t = this.plugin.t.recording;

        // Check support
        if (!isRecordingSupported()) {
            contentEl.createEl('p', { text: t?.notSupported || 'Audio recording not supported in this environment' });
            return;
        }

        // Check mime support (with fallback info)
        const mime = selectMime();
        if (!mime) {
            // Fallback path will be handled by AudioRecordingService
            // Just warn if even the fallback might not work
            logger.debug('Audio', 'No pre-negotiated mime type; will use browser default');
        }

        // Title
        contentEl.createEl('h2', { text: t?.title || 'Record Audio' });

        // Timer display
        this.timerEl = contentEl.createDiv({ cls: 'ai-organiser-audio-recorder-timer' });
        this.timerEl.textContent = '00:00:00';

        // Size display
        this.sizeEl = contentEl.createDiv({ cls: 'ai-organiser-audio-recorder-size' });
        this.sizeEl.textContent = '0.0 MB';

        // Max time hint (mobile only, when auto-transcribe makes sense)
        if (Platform.isMobile) {
            const quality: RecordingQuality = this.plugin.settings.recordingQuality || 'speech';
            const maxMin = getMaxRecordingMinutes(quality);
            const maxTimeEl = contentEl.createDiv({ cls: 'ai-organiser-audio-recorder-max-time' });
            maxTimeEl.textContent = (t?.maxRecordingTime || 'Max ~{minutes} min for auto-transcription')
                .replace('{minutes}', String(maxMin));
        }

        // Controls (Record/Stop/Play)
        this.controlsEl = contentEl.createDiv({ cls: 'ai-organiser-audio-recorder-controls' });
        this.renderControls();

        // Output options (hidden in minutes and multi-source modes)
        if (this.options.mode === 'standalone') {
            this.renderOutputOptions(contentEl);
        }

        // Status message area
        this.statusEl = contentEl.createDiv({ cls: 'ai-organiser-audio-recorder-status' });
    }

    private renderControls(): void {
        if (!this.controlsEl) return;
        this.controlsEl.empty();

        const t = this.plugin.t.recording;

        switch (this.state) {
            case 'idle': {
                const recordBtn = this.controlsEl.createEl('button', {
                    text: t?.record || 'Record',
                    cls: 'mod-cta'
                });
                const iconSpan = recordBtn.createSpan({ cls: 'ai-organiser-audio-recorder-btn-icon' });
                setIcon(iconSpan, 'mic');
                this.cleanups.push(listen(recordBtn, 'click', () => { void this.startRecording(); }));
                break;
            }
            case 'recording': {
                const stopBtn = this.controlsEl.createEl('button', {
                    text: t?.stop || 'Stop',
                    cls: 'mod-warning'
                });
                const iconSpan = stopBtn.createSpan({ cls: 'ai-organiser-audio-recorder-btn-icon' });
                setIcon(iconSpan, 'square');
                this.cleanups.push(listen(stopBtn, 'click', () => { void this.stopRecording(); }));
                break;
            }
            case 'stopped': {
                // Play button
                const playBtn = this.controlsEl.createEl('button', {
                    text: t?.play || 'Play'
                });
                const playIcon = playBtn.createSpan({ cls: 'ai-organiser-audio-recorder-btn-icon' });
                setIcon(playIcon, 'play');
                this.cleanups.push(listen(playBtn, 'click', () => this.playRecording()));

                // Re-record button
                const reRecordBtn = this.controlsEl.createEl('button', {
                    text: t?.record || 'Record'
                });
                const reIcon = reRecordBtn.createSpan({ cls: 'ai-organiser-audio-recorder-btn-icon' });
                setIcon(reIcon, 'mic');
                this.cleanups.push(listen(reRecordBtn, 'click', () => {
                    // Don't null filenameInput here — if startRecording() fails,
                    // the user stays in 'stopped' state and the input must still work.
                    // renderControls() rebuilds the DOM (including a fresh input) on success.
                    void this.startRecording();
                }));

                // Filename input (standalone mode only)
                if (this.options.mode === 'standalone') {
                    const nameRow = this.controlsEl.createDiv({ cls: 'ai-organiser-audio-recorder-name-row' });
                    this.filenameInput = nameRow.createEl('input', {
                        type: 'text',
                        placeholder: t?.filenamePlaceholder || 'Recording name (optional)',
                        cls: 'ai-organiser-audio-recorder-filename'
                    });
                }

                // Action buttons
                const saveBtn = this.controlsEl.createEl('button', {
                    text: t?.save || 'Save',
                    cls: 'mod-cta'
                });
                this.cleanups.push(listen(saveBtn, 'click', () => { void this.saveRecording(); }));

                const discardBtn = this.controlsEl.createEl('button', {
                    text: t?.discard || 'Discard'
                });
                this.cleanups.push(listen(discardBtn, 'click', () => this.discardAndClose()));
                break;
            }
            case 'saving':
            case 'transcribing': {
                const statusText = this.state === 'transcribing'
                    ? (t?.transcribing || 'Transcribing...')
                    : (t?.saving || 'Saving...');
                this.controlsEl.createEl('span', { text: statusText, cls: 'ai-organiser-audio-recorder-busy' });
                break;
            }
        }
    }

    private renderOutputOptions(container: HTMLElement): void {
        this.outputEl = container.createDiv({ cls: 'ai-organiser-audio-recorder-output' });
        const t = this.plugin.t.recording;

        // Output choice heading
        this.outputEl.createEl('div', {
            text: 'Output:',
            cls: 'ai-organiser-audio-recorder-output-label'
        });

        // Radio: Insert at cursor
        const hasEditor = !!this.app.workspace.activeEditor?.editor;
        const cursorLabel = this.outputEl.createEl('label', { cls: 'ai-organiser-audio-recorder-radio' });
        const cursorRadio = cursorLabel.createEl('input', {
            type: 'radio',
            attr: { name: 'output-choice', value: 'cursor' }
        });
        cursorRadio.checked = hasEditor;
        cursorRadio.disabled = !hasEditor;
        cursorLabel.appendText(t?.insertAtCursor || 'Insert transcript at cursor');
        if (!hasEditor) {
            cursorLabel.createEl('small', {
                text: ` (${t?.noEditorAvailable || 'no active editor'})`,
                cls: 'ai-organiser-audio-recorder-hint'
            });
        }
        this.outputRadios.push(cursorRadio);

        // Radio: Create new note
        const noteLabel = this.outputEl.createEl('label', { cls: 'ai-organiser-audio-recorder-radio' });
        const noteRadio = noteLabel.createEl('input', {
            type: 'radio',
            attr: { name: 'output-choice', value: 'note' }
        });
        noteRadio.checked = !hasEditor;
        noteLabel.appendText(t?.createNewNote || 'Create new note');
        this.outputRadios.push(noteRadio);

        // Checkbox: Embed audio
        const embedLabel = this.outputEl.createEl('label', { cls: 'ai-organiser-audio-recorder-checkbox' });
        this.embedCheckbox = embedLabel.createEl('input', { type: 'checkbox' });
        this.embedCheckbox.checked = this.plugin.settings.embedAudioInNote !== false;
        embedLabel.appendText(t?.embedAudio || 'Embed audio file in note');

        // Checkbox: Auto-transcribe
        const transcribeLabel = this.outputEl.createEl('label', { cls: 'ai-organiser-audio-recorder-checkbox' });
        this.autoTranscribeCheckbox = transcribeLabel.createEl('input', { type: 'checkbox' });
        this.autoTranscribeCheckbox.checked = this.plugin.settings.autoTranscribeRecordings !== false;
        transcribeLabel.appendText(t?.autoTranscribe || 'Auto-transcribe after recording');
    }

    private async startRecording(): Promise<void> {
        try {
            const quality: RecordingQuality = this.plugin.settings.recordingQuality || 'speech';
            await this.recorder.startRecording(RECORDING_BITRATES[quality]);
            this.state = 'recording';
            this.blob = null;
            this.revokeAudioUrl();
            this.contentEl.addClass('ai-organiser-audio-recorder-recording');
            this.renderControls();
            this.startTimer();
        } catch (err: unknown) {
            const errObj = err as { name?: string; message?: string };
            if (errObj?.name === 'NotAllowedError') {
                const t = this.plugin.t.recording;
                new Notice(t?.micPermissionDenied || 'Microphone access denied. Check permissions.');
            } else {
                new Notice('Failed to start recording: ' + (errObj?.message || 'Unknown error'));
            }
        }
    }

    private async stopRecording(): Promise<void> {
        try {
            this.blob = await this.recorder.stopRecording();
            this.state = 'stopped';
            this.contentEl.removeClass('ai-organiser-audio-recorder-recording');
            this.stopTimer();
            this.renderControls();
            this.updateAutoTranscribeState();
        } catch (err: unknown) {
            const errObj = err as { name?: string; message?: string };
            new Notice('Failed to stop recording: ' + (errObj?.message || 'Unknown error'));
        }
    }

    private playRecording(): void {
        if (!this.blob) return;
        this.revokeAudioUrl();
        this.audioUrl = URL.createObjectURL(this.blob);
        const audio = new Audio(this.audioUrl);
        void audio.play();
    }

    private updateAutoTranscribeState(): void {
        if (!this.autoTranscribeCheckbox) return;
        const tooLarge = this.recorder.getRecordedBytes() > MAX_FILE_SIZE_BYTES;
        if (tooLarge) {
            this.autoTranscribeCheckbox.checked = false;
            this.autoTranscribeCheckbox.disabled = true;
        }
    }

    /** Save blob to vault as a binary recording file. */
    private async saveBlobToVault(suffix = ''): Promise<TFile> {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const ext = this.recorder.getMimeSelection().extension;
        const defaultName = `recording-${timestamp}`;

        // For autosave (emergency recovery), always use timestamp for deterministic naming.
        // For explicit save, use custom name if provided (standalone mode).
        const isAutosave = suffix === '-unsaved';
        const rawName = (!isAutosave && this.filenameInput?.value.trim()) || '';
        let baseName: string;
        if (rawName) {
            // Strip any user-typed extension to avoid double-extension (e.g. "meeting.webm.webm")
            const stripped = rawName.replace(/\.[^.]+$/, '');
            const sanitized = sanitizeFileName(stripped || rawName);
            // Guard: if sanitization yields empty or dots-only, fall back to timestamp
            baseName = (sanitized && !/^\.+$/.test(sanitized)) ? sanitized : defaultName;
        } else {
            baseName = defaultName;
        }

        const fileName = `${baseName}${suffix}${ext}`;
        const recordingFolder = getOutputSubfolderPath(this.plugin.settings, DEFAULT_RECORDING_FOLDER);
        await ensureFolderExists(this.app.vault, recordingFolder);

        // Resolve collisions: "Meeting.webm" → "Meeting (2).webm" if exists
        const safePath = await getAvailableFilePath(this.app.vault, recordingFolder, fileName);

        const arrayBuffer = await this.blob!.arrayBuffer();
        return this.app.vault.createBinary(safePath, arrayBuffer);
    }

    private async saveRecording(): Promise<void> {
        if (!this.blob || this.blob.size === 0) {
            new Notice('No recording to save');
            return;
        }

        this.state = 'saving';
        this.renderControls();

        const t = this.plugin.t.recording;

        try {
            const savedFile = await this.saveBlobToVault();

            const duration = this.recorder.getElapsedSeconds();
            let transcript: string | undefined;

            // Auto-transcribe if enabled and size is valid
            const shouldTranscribe = this.shouldAutoTranscribe();
            if (shouldTranscribe) {
                this.state = 'transcribing';
                this.renderControls();
                if (this.statusEl) {
                    this.statusEl.textContent = t?.transcribing || 'Transcribing...';
                }

                transcript = await this.transcribeFile(savedFile);
            }

            this.actionFired = true;

            // Show success notice
            if (transcript) {
                new Notice(t?.savedAndTranscribed || 'Recording saved and transcribed');
            } else {
                new Notice(t?.saved || 'Recording saved');
                if (this.blob.size > MAX_FILE_SIZE_BYTES) {
                    new Notice(t?.tooLargeForAutoTranscribe || 'Recording exceeds 25 MB — transcribe on desktop with FFmpeg.');
                }
            }

            // Post-save storage options: resolve BEFORE handleOutput so embeds
            // point to the correct file (compressed .mp3) or are skipped (delete).
            if (this.options.mode === 'standalone' && transcript) {
                const policy = this.plugin.settings.postRecordingStorage || 'ask';
                if (policy === 'ask') {
                    this.state = 'post-save';
                    this.renderPostSaveOptions(savedFile, transcript, duration);
                    return; // Don't close — user picks, then completes output
                }
                const finalFile = await this.applyStoragePolicy(policy, savedFile);
                await this.handleOutput(finalFile, transcript, duration);
            } else {
                await this.handleOutput(savedFile, transcript, duration);
            }

            this.close();
        } catch (err: unknown) {
            const errObj = err as { name?: string; message?: string };
            new Notice('Failed to save recording: ' + (errObj?.message || 'Unknown error'));
            this.state = 'stopped';
            this.renderControls();
            if (this.statusEl) this.statusEl.textContent = '';
        }
    }

    private shouldAutoTranscribe(): boolean {
        // In multi-source mode, never auto-transcribe (file goes to source list)
        if (this.options.mode === 'multi-source') return false;

        // Check user preference
        if (this.autoTranscribeCheckbox && !this.autoTranscribeCheckbox.checked) return false;

        // Check settings for modes without checkbox
        if (this.options.mode === 'minutes' && this.plugin.settings.autoTranscribeRecordings === false) return false;

        // Check size limit
        if (!this.blob || this.blob.size > MAX_FILE_SIZE_BYTES) return false;

        return true;
    }

    private async transcribeFile(file: TFile): Promise<string | undefined> {
        try {
            const apiKeyResult = await getAudioTranscriptionApiKey(this.plugin);
            if (!apiKeyResult) return undefined;

            const language = this.options.transcriptionLanguage || 'auto';

            // Use transcribeAudio() directly — safe on both desktop and mobile
            // (transcribeAudioWithFullWorkflow imports FFmpeg-dependent code that crashes on mobile)
            const result = await transcribeAudio(this.app, file, {
                provider: apiKeyResult.provider,
                apiKey: apiKeyResult.key,
                language: language === 'auto' ? undefined : language
            });

            if (result.success && result.transcript) {
                return result.transcript;
            }
            return undefined;
        } catch (err) {
            logger.error('Audio', 'Transcription failed:', err);
            return undefined;
        }
    }

    private async handleOutput(file: TFile | null, transcript: string | undefined, duration: number): Promise<void> {
        if (this.options.mode === 'minutes' || this.options.mode === 'multi-source') {
            // Callback mode — let parent modal handle it (file should always exist here)
            if (file) this.options.onComplete?.({ file, transcript, duration });
            return;
        }

        // Standalone mode — insert into editor or create note
        const outputChoice = this.getSelectedOutput();
        const shouldEmbed = file && (this.embedCheckbox?.checked ?? true);
        const embedLink = shouldEmbed ? `![[${file.name}]]\n\n` : '';
        const content = embedLink + (transcript || '');

        // Guard: don't create an empty note or insert nothing
        if (!content.trim()) return;

        if (outputChoice === 'cursor') {
            const editor = this.app.workspace.activeEditor?.editor;
            if (editor) {
                insertAtCursor(editor, content);
            }
        } else {
            // Create new note (collision-safe)
            const baseName = file ? file.name.replace(/\.[^.]+$/, '') : 'recording';
            const noteFolder = getOutputSubfolderPath(this.plugin.settings, DEFAULT_RECORDING_FOLDER);
            const safePath = await getAvailableFilePath(this.app.vault, noteFolder, baseName + '.md');
            await this.app.vault.create(safePath, content);
            await this.app.workspace.openLinkText(safePath, '', false);
        }

        if (file) this.options.onComplete?.({ file, transcript, duration });
    }

    private renderPostSaveOptions(savedFile: TFile, transcript: string, duration: number): void {
        if (!this.controlsEl) return;
        this.controlsEl.empty();

        const t = this.plugin.t.recording;
        const fileSize = formatFileSize(savedFile.stat.size);

        // Title
        const titleEl = this.controlsEl.createDiv({ cls: 'ai-organiser-audio-recorder-post-save-title' });
        titleEl.textContent = t?.postRecordingTitle || 'What to do with the audio file?';

        // File size info
        const infoEl = this.controlsEl.createDiv({ cls: 'ai-organiser-audio-recorder-post-save-info' });
        infoEl.textContent = `${savedFile.name} (${fileSize})`;

        // Buttons
        const btnRow = this.controlsEl.createDiv({ cls: 'ai-organiser-audio-recorder-post-save-buttons' });

        // Helper: complete output and close
        const finishWith = async (file: TFile | null) => {
            await this.handleOutput(file, transcript, duration);
            this.close();
        };

        // Keep original
        const keepBtn = btnRow.createEl('button', {
            text: t?.keepOriginal || 'Keep original',
            attr: { title: t?.keepOriginalDesc || 'Keep the full-quality recording' }
        });
        this.cleanups.push(listen(keepBtn, 'click', () => { void finishWith(savedFile); }));

        // Keep compressed (desktop only, requires FFmpeg)
        if (!Platform.isMobile) {
            const compressBtn = btnRow.createEl('button', {
                text: t?.keepCompressed || 'Keep compressed',
                attr: { title: t?.keepCompressedDesc || 'Replace with smaller MP3' }
            });
            this.cleanups.push(listen(compressBtn, 'click', () => { void (async () => {
                compressBtn.disabled = true;
                compressBtn.textContent = t?.compressing || 'Compressing...';
                const compressedFile = await this.compressAndReplace(savedFile);
                await finishWith(compressedFile ?? savedFile);
            })(); }));
        }

        // Delete audio
        const deleteBtn = btnRow.createEl('button', {
            text: t?.deleteAudio || 'Delete audio',
            cls: 'mod-warning',
            attr: { title: t?.deleteAudioDesc || 'Remove audio file (transcript saved)' }
        });
        this.cleanups.push(listen(deleteBtn, 'click', () => { void (async () => {
            await this.deleteRecording(savedFile);
            await finishWith(null);
        })(); }));
    }

    /** Apply storage policy and return the final file (null if deleted, new TFile if compressed). */
    private async applyStoragePolicy(policy: string, file: TFile): Promise<TFile | null> {
        if (policy === 'keep-compressed' && !Platform.isMobile) {
            return await this.compressAndReplace(file) ?? file;
        } else if (policy === 'delete') {
            await this.deleteRecording(file);
            return null;
        }
        return file; // 'keep-original' → unchanged
    }

    /** Compress file to MP3, replace original (backlink-safe). Returns new TFile or undefined on failure. */
    private async compressAndReplace(file: TFile): Promise<TFile | undefined> {
        const t = this.plugin.t.recording;
        try {
            // Dynamic import to avoid loading FFmpeg code on mobile
            const { compressAudio, isFFmpegAvailable, replaceAudioFile } = await import('../../services/audioCompressionService');
            const ffmpegOk = await isFFmpegAvailable();
            if (!ffmpegOk) {
                new Notice(t?.compressionFailed || 'Compression failed — keeping original');
                return undefined;
            }

            const result = await compressAudio(this.app, file);
            if (!result.success || !result.data) {
                new Notice(t?.compressionFailed || 'Compression failed — keeping original');
                return undefined;
            }

            // Backlink-safe replacement: modifyBinary + renameFile
            const { newFile } = await replaceAudioFile(this.app, file, result.data, 'mp3');

            const originalSize = formatFileSize(file.stat.size);
            const compressedSize = formatFileSize(result.data.byteLength);
            new Notice(`${t?.audioCompressed || 'Audio compressed'} (${originalSize} → ${compressedSize})`);
            return newFile;
        } catch (err) {
            logger.error('Audio', 'Compression failed:', err);
            new Notice(t?.compressionFailed || 'Compression failed — keeping original');
            return undefined;
        }
    }

    private async deleteRecording(file: TFile): Promise<void> {
        const t = this.plugin.t.recording;
        try {
            await this.app.fileManager.trashFile(file);
            new Notice(t?.audioDeleted || 'Audio file deleted');
        } catch (err) {
            logger.error('Audio', 'Failed to delete recording:', err);
        }
    }

    private getSelectedOutput(): 'cursor' | 'note' {
        for (const radio of this.outputRadios) {
            if (radio.checked) return radio.value as 'cursor' | 'note';
        }
        return 'note';
    }

    private startTimer(): void {
        this.stopTimer();
        this.timerInterval = setInterval(() => {
            this.updateTimerDisplay();
            this.updateSizeDisplay();
            this.updateAutoTranscribeState();
        }, 1000);
    }

    private stopTimer(): void {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    private updateTimerDisplay(): void {
        if (!this.timerEl) return;
        const elapsed = this.recorder.getElapsedSeconds();
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        this.timerEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    private updateSizeDisplay(): void {
        if (!this.sizeEl) return;
        const bytes = this.recorder.getRecordedBytes();
        const mb = bytes / (1024 * 1024);
        this.sizeEl.textContent = `${mb.toFixed(1)} MB`;
    }

    private revokeAudioUrl(): void {
        if (this.audioUrl) {
            URL.revokeObjectURL(this.audioUrl);
            this.audioUrl = null;
        }
    }

    private discardAndClose(): void {
        this.actionFired = true;
        this.close();
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];

        // If recording or has unsaved data, auto-save to prevent data loss.
        // Modal.onClose can't be async-blocked for a confirmation dialog,
        // so we save unconditionally and notify the user.
        if (!this.actionFired && (this.recorder.isRecording() || this.recorder.hasData())) {
            void (async () => {
                const t = this.plugin.t.recording;
                const isActive = this.recorder.isRecording();

                if (isActive) {
                    try {
                        this.blob = await this.recorder.stopRecording();
                    } catch {
                        // Best effort
                    }
                }

                // Attempt auto-save to prevent data loss
                if (this.blob && this.blob.size > 0) {
                    try {
                        await this.saveBlobToVault('-unsaved');
                        new Notice(t?.saved || 'Recording auto-saved');
                    } catch {
                        logger.warn('Audio', 'Failed to auto-save recording on close');
                    }
                }
            })();
        }

        this.stopTimer();
        this.revokeAudioUrl();
        this.recorder.dispose();
    }
}
