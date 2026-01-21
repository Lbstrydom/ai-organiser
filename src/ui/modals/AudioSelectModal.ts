/**
 * Audio Select Modal
 * Modal for selecting an audio file from the vault to transcribe
 * Supports files over 25MB with compression indicator
 */

import { App, Modal, TFile, setIcon, Setting } from 'obsidian';
import { Translations } from '../../i18n/types';
import {
    getAllAudioFiles,
    formatFileSize,
    MAX_FILE_SIZE_MB
} from '../../services/audioTranscriptionService';
import { needsCompression, getCompressionEstimate } from '../../services/audioCompressionService';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';

export interface AudioSelectResult {
    file: TFile;
    language: string;
    context: string;
    needsCompression: boolean;
}

export class AudioSelectModal extends Modal {
    private t: Translations;
    private onSelect: (result: AudioSelectResult) => void;
    private audioFiles: TFile[];
    private searchQuery: string = '';
    private selectedFile: TFile | null = null;
    private selectedLanguage: string = 'auto';
    private contextPrompt: string = '';
    private compressionNotice: HTMLElement | null = null;

    constructor(
        app: App,
        t: Translations,
        onSelect: (result: AudioSelectResult) => void
    ) {
        super(app);
        this.t = t;
        this.onSelect = onSelect;
        this.audioFiles = getAllAudioFiles(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('audio-select-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.audioSelect?.title || 'Select Audio File'
        });

        // Description - updated to mention compression
        contentEl.createEl('p', {
            text: this.t.modals.audioSelect?.description ||
                `Select an audio file to transcribe. Files over ${MAX_FILE_SIZE_MB}MB will be compressed automatically.`,
            cls: 'audio-select-description'
        });

        // Search input
        const searchContainer = contentEl.createEl('div', { cls: 'audio-select-search' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: this.t.modals.audioSelect?.searchPlaceholder || 'Search audio files...',
            cls: 'audio-select-search-input'
        });

        // File list container (declare before use in event handler)
        const fileListContainer = contentEl.createEl('div', { cls: 'audio-list' });

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
            this.renderFileList(fileListContainer);
        });

        // File count
        const countEl = contentEl.createEl('p', {
            text: (this.t.modals.audioSelect?.filesFound || '{count} audio files found')
                .replace('{count}', String(this.audioFiles.length)),
            cls: 'audio-select-count'
        });

        if (this.audioFiles.length === 0) {
            countEl.setText(this.t.modals.audioSelect?.noFiles || 'No audio files found in vault');
            countEl.addClass('audio-select-no-files');
            return;
        }

        // Render file list
        this.renderFileList(fileListContainer);

        // Compression notice (hidden by default)
        this.compressionNotice = contentEl.createEl('div', {
            cls: 'audio-compression-notice hidden'
        });
        const noticeIcon = this.compressionNotice.createEl('span', { cls: 'compression-notice-icon' });
        setIcon(noticeIcon, 'file-down');
        this.compressionNotice.createEl('span', {
            cls: 'compression-notice-text'
        });

        // Transcription options section
        const optionsSection = contentEl.createEl('div', { cls: 'audio-select-options' });

        // Language dropdown
        new Setting(optionsSection)
            .setName(this.t.modals.audioSelect?.languageLabel || 'Audio Language')
            .setDesc(this.t.modals.audioSelect?.languageDesc || 'Specify the language for better accuracy')
            .addDropdown(dropdown => {
                // Add language options
                for (const lang of COMMON_LANGUAGES) {
                    dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                }
                dropdown.setValue(this.selectedLanguage);
                dropdown.onChange(value => {
                    this.selectedLanguage = value;
                });
            });

        // Context input
        new Setting(optionsSection)
            .setName(this.t.modals.audioSelect?.contextLabel || 'Context (Optional)')
            .setDesc(this.t.modals.audioSelect?.contextDesc || 'Describe the audio content to improve transcription accuracy')
            .addTextArea(text => {
                text
                    .setPlaceholder(this.t.modals.audioSelect?.contextPlaceholder ||
                        'e.g., A lecture about quantum physics discussing entanglement and superposition')
                    .setValue(this.contextPrompt)
                    .onChange(value => {
                        this.contextPrompt = value;
                    });
                text.inputEl.rows = 2;
                text.inputEl.addClass('audio-select-context-input');
            });

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'audio-select-buttons' });

        const cancelButton = buttonContainer.createEl('button', {
            text: this.t.modals.cancelButton || 'Cancel'
        });
        cancelButton.addEventListener('click', () => this.close());

        const submitButton = buttonContainer.createEl('button', {
            text: this.t.modals.audioSelect?.selectButton || 'Transcribe',
            cls: 'mod-cta'
        });
        submitButton.addEventListener('click', () => this.submit());

        // Disable submit if no file selected
        this.updateSubmitButton(submitButton);
    }

    private renderFileList(container: HTMLElement) {
        container.empty();

        // Filter files based on search
        const filteredFiles = this.audioFiles.filter(file =>
            file.name.toLowerCase().includes(this.searchQuery) ||
            file.path.toLowerCase().includes(this.searchQuery)
        );

        // Sort by modification time (most recent first)
        filteredFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

        for (const file of filteredFiles) {
            const fileSize = file.stat.size;
            const requiresCompression = needsCompression(fileSize);
            const isSelected = this.selectedFile?.path === file.path;

            const item = container.createEl('div', {
                cls: `audio-list-item ${requiresCompression ? 'needs-compression' : ''} ${isSelected ? 'selected' : ''}`
            });

            // Icon
            const iconEl = item.createEl('span', { cls: 'audio-icon' });
            setIcon(iconEl, this.getAudioIcon(file.extension));

            // File info
            const info = item.createEl('div', { cls: 'audio-info' });

            const nameRow = info.createEl('div', { cls: 'audio-name' });
            nameRow.createEl('span', {
                text: file.name,
                cls: 'audio-name-text'
            });
            nameRow.createEl('span', {
                text: file.extension.toUpperCase(),
                cls: 'audio-format'
            });

            // Compression badge for large files
            if (requiresCompression) {
                const badge = nameRow.createEl('span', {
                    text: this.t.modals.audioSelect?.compressionBadge || 'Will compress',
                    cls: 'audio-compression-badge'
                });
                badge.setAttribute('title',
                    (this.t.modals.audioSelect?.compressionTooltip ||
                        'This file will be compressed before transcription')
                );
            }

            // Meta info
            const meta = info.createEl('div', { cls: 'audio-meta' });
            const sizeEl = meta.createEl('span', {
                text: formatFileSize(fileSize),
                cls: `audio-size ${requiresCompression ? 'large-file' : ''}`
            });

            if (requiresCompression) {
                sizeEl.setAttribute('title',
                    (this.t.modals.audioSelect?.largeFileTooltip ||
                        'File exceeds {maxSize}MB - will be compressed automatically')
                        .replace('{maxSize}', String(MAX_FILE_SIZE_MB))
                );
            }

            const dateStr = new Date(file.stat.mtime).toLocaleDateString();
            meta.createEl('span', {
                text: dateStr,
                cls: 'audio-modified'
            });

            // Click handler - all files are now selectable
            item.addEventListener('click', () => {
                // Deselect previous
                container.querySelectorAll('.audio-list-item.selected').forEach(el => {
                    el.removeClass('selected');
                });
                // Select this one
                item.addClass('selected');
                this.selectedFile = file;

                // Update compression notice
                this.updateCompressionNotice(file);

                // Update submit button
                const submitBtn = this.contentEl.querySelector('.mod-cta') as HTMLButtonElement;
                if (submitBtn) {
                    this.updateSubmitButton(submitBtn);
                }
            });
        }

        if (filteredFiles.length === 0) {
            container.createEl('div', {
                text: this.t.modals.audioSelect?.noMatchingFiles || 'No matching files',
                cls: 'audio-select-empty'
            });
        }
    }

    private updateCompressionNotice(file: TFile) {
        if (!this.compressionNotice) return;

        const fileSize = file.stat.size;
        const requiresCompression = needsCompression(fileSize);

        if (requiresCompression) {
            this.compressionNotice.removeClass('hidden');
            const textEl = this.compressionNotice.querySelector('.compression-notice-text');
            if (textEl) {
                textEl.textContent = getCompressionEstimate(fileSize);
            }
        } else {
            this.compressionNotice.addClass('hidden');
        }
    }

    private updateSubmitButton(button: HTMLButtonElement) {
        button.disabled = !this.selectedFile;
        if (!this.selectedFile) {
            button.addClass('disabled');
            button.textContent = this.t.modals.audioSelect?.selectButton || 'Transcribe';
        } else {
            button.removeClass('disabled');
            // Update button text based on whether compression is needed
            const requiresCompression = needsCompression(this.selectedFile.stat.size);
            if (requiresCompression) {
                button.textContent = this.t.modals.audioSelect?.compressAndTranscribe || 'Compress & Transcribe';
            } else {
                button.textContent = this.t.modals.audioSelect?.selectButton || 'Transcribe';
            }
        }
    }

    private submit() {
        if (this.selectedFile) {
            const requiresCompression = needsCompression(this.selectedFile.stat.size);
            this.close();
            this.onSelect({
                file: this.selectedFile,
                language: this.selectedLanguage === 'auto' ? '' : this.selectedLanguage,
                context: this.contextPrompt.trim(),
                needsCompression: requiresCompression
            });
        }
    }

    private getAudioIcon(extension: string): string {
        // Map extensions to appropriate icons
        const iconMap: Record<string, string> = {
            'mp3': 'music',
            'wav': 'audio-waveform',
            'm4a': 'music',
            'ogg': 'music',
            'webm': 'video',
            'mp4': 'video'
        };
        return iconMap[extension.toLowerCase()] || 'file-audio';
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
