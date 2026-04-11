/**
 * NotebookLM Export Modal
 *
 * Full state map:
 *   idle-zero      — 0 notes selected
 *   idle-first     — first export (no previous pack)
 *   idle-previous  — previous pack exists; shows "New pack" + "Update pack" buttons
 *   exporting      — progress bar + cancel button
 *   success        — complete; open-folder (desktop) or path display (mobile)
 *   failure        — error callout
 *   aborted        — cancellation confirmed
 */

import { App, Modal, Platform, Setting, ProgressBarComponent } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { SourcePackConfig, ExportPreview, LinkedDocument } from '../../services/notebooklm/types';
import { formatBytes } from '../../services/notebooklm/notebooklmUtils';
import { listen } from '../utils/domUtils';
import { getElectron } from '../../utils/desktopRequire';

export interface NotebookLMExportResult {
    proceed: boolean;
    mode: 'new' | 'update';
    config: SourcePackConfig;
}

export class NotebookLMExportModal extends Modal {
    private preview: ExportPreview;
    private config: SourcePackConfig;
    private onSubmit: (result: NotebookLMExportResult, signal: AbortSignal) => void;
    private t: Translations;

    // Abort / lifecycle
    private abortController = new AbortController();
    private isDisposed = false;
    private cleanups: (() => void)[] = [];

    // Progress UI elements
    private progressContainer: HTMLElement | null = null;
    private progressBar: ProgressBarComponent | null = null;
    private progressMessage: HTMLElement | null = null;
    private cancelBtn: HTMLButtonElement | null = null;
    private isExporting = false;

    // Post-export result folder path
    private resultFolderPath: string | null = null;

    constructor(
        app: App,
        translations: Translations,
        preview: ExportPreview,
        onSubmit: (result: NotebookLMExportResult, signal: AbortSignal) => void
    ) {
        super(app);
        this.t = translations;
        this.preview = preview;
        this.config = { ...preview.config };
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        this.abortController = new AbortController();
        this.isDisposed = false;
        this.renderIdle();
    }

    onClose(): void {
        this.isDisposed = true;
        this.abortController.abort();
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
        this.progressContainer = null;
        this.progressBar = null;
        this.progressMessage = null;
        this.cancelBtn = null;
    }

    // ─── Public API (called from command handler) ───────────────────────────

    updateProgress(current: number, total: number, message: string): void {
        if (this.isDisposed) return;
        if (this.progressBar) {
            this.progressBar.setValue(total > 0 ? (current / total) * 100 : 0);
        }
        if (this.progressMessage) {
            const prog = this.t.notebooklm?.exportProgress
                ? this.t.notebooklm.exportProgress
                    .replace('{current}', String(current))
                    .replace('{total}', String(total))
                : `${current} of ${total}`;
            this.progressMessage.setText(`${prog} — ${message}`);
        }
    }

    showComplete(success: boolean, packFolderPath?: string, warnings?: string[], errorMessage?: string): void {
        if (this.isDisposed) return;
        this.isExporting = false;
        this.resultFolderPath = packFolderPath ?? null;

        if (success) {
            this.renderSuccess(packFolderPath, warnings);
        } else if (errorMessage === 'Export cancelled') {
            this.renderAborted();
        } else {
            this.renderFailure(errorMessage);
        }
    }

    // ─── Render helpers ──────────────────────────────────────────────────────

    private renderIdle(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.cleanups = [];
        contentEl.addClass('ai-organiser-modal-content');

        const mt = this.t.modals.notebookLMExport;

        contentEl.createEl('h2', { text: mt.title });
        contentEl.createEl('p', { text: mt.description, cls: 'setting-item-description' });

        // 0-notes state
        if (this.preview.selection.files.length === 0) {
            const warn = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-callout ai-organiser-notebooklm-callout--warning' });
            warn.createEl('p', { text: this.t.messages.notebookLMNoSelection });
            new Setting(contentEl).addButton(btn =>
                btn.setButtonText('Close').onClick(() => this.close())
            );
            return;
        }

        // Stats
        const statsDiv = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-stats' });
        statsDiv.createEl('h4', { text: mt.statsTitle });
        statsDiv.createEl('p', { text: `${mt.noteCount}: ${this.preview.selection.files.length}` });
        statsDiv.createEl('p', { text: `${mt.scope}: ${this.preview.selection.scopeValue}` });
        statsDiv.createEl('p', { text: `Estimated size: ${formatBytes(this.preview.estimatedSizeBytes)}` });

        // Sidecar documents section (Fix 4)
        if (this.preview.linkedDocuments.length > 0) {
            this.renderSidecarSection(contentEl, this.preview.linkedDocuments);
        }

        // Source count / size warnings
        if (this.preview.warnings.sourceCountWarning || this.preview.warnings.totalSizeWarning) {
            const warnDiv = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-callout ai-organiser-notebooklm-callout--error' });
            if (this.preview.warnings.sourceCountWarning) {
                warnDiv.createEl('p', { text: this.preview.warnings.sourceCountWarning });
            }
            if (this.preview.warnings.totalSizeWarning) {
                warnDiv.createEl('p', { text: this.preview.warnings.totalSizeWarning });
            }
        }

        // Post-export action
        new Setting(contentEl)
            .setName(mt.postExportLabel)
            .setDesc(mt.postExportDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOption('keep', mt.actionKeep)
                    .addOption('clear', mt.actionClear)
                    .addOption('archive', mt.actionArchive)
                    .setValue(this.config.postExportTagAction)
                    .onChange(value => {
                        this.config.postExportTagAction = value as 'keep' | 'clear' | 'archive';
                    })
            );

        // Progress container (hidden initially)
        this.progressContainer = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-progress ai-organiser-hidden' });
        this.progressMessage = this.progressContainer.createEl('p', { cls: 'setting-item-description' });
        this.progressBar = new ProgressBarComponent(this.progressContainer.createDiv());
        this.progressBar.setValue(0);

        // Buttons
        const buttonsDiv = contentEl.createDiv({ cls: 'modal-button-container ai-organiser-notebooklm-buttons' });

        // Cancel / close button (always present)
        const cancelSetting = new Setting(buttonsDiv);
        cancelSetting.addButton(btn => {
            this.cancelBtn = btn.buttonEl;
            btn.setButtonText(this.t.notebooklm?.cancelButton || 'Cancel');
            this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                if (this.isExporting) {
                    this.abortController.abort();
                } else {
                    this.onSubmit({ proceed: false, mode: 'new', config: this.config }, this.abortController.signal);
                    this.close();
                }
            }));
        });

        if (this.preview.hasPreviousPack) {
            // Two-button layout: "New pack" + "Update pack (N changed)"
            this.renderUpdatePackButtons(cancelSetting);
        } else {
            // Single export button
            cancelSetting.addButton(btn => {
                btn.setButtonText(mt.exportButton).setCta();
                this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                    if (!this.isExporting) this.startExport('new');
                }));
            });
        }
    }

    private renderSidecarSection(container: HTMLElement, docs: LinkedDocument[]): void {
        const section = container.createDiv({ cls: 'ai-organiser-notebooklm-sidecar-section' });
        section.createEl('h4', { text: this.t.notebooklm?.sidecarTitle || 'Attached documents — upload these too' });

        const COLLAPSED_MAX = 3;
        const showAll = docs.length <= COLLAPSED_MAX;

        // List container
        const list = section.createEl('ul', { cls: 'ai-organiser-notebooklm-sidecar-list' });
        const visibleDocs = showAll ? docs : docs.slice(0, COLLAPSED_MAX);

        for (const doc of visibleDocs) {
            const item = list.createEl('li');
            const icon = doc.type === 'pdf' ? '📄' : '📎';
            item.createEl('span', { text: `${icon} ${doc.displayName}` });
            if (doc.sizeBytes != null && doc.sizeBytes > 0) {
                item.createEl('span', {
                    text: ` (${formatBytes(doc.sizeBytes)})`,
                    cls: 'setting-item-description'
                });
            }
        }

        // "Show N more" toggle for 4+ files
        if (!showAll) {
            const remaining = docs.length - COLLAPSED_MAX;
            const moreEl = section.createEl('button', {
                text: (this.t.notebooklm?.sidecarShowMore || 'Show {n} more')
                    .replace('{n}', String(remaining)),
                cls: 'ai-organiser-notebooklm-sidecar-toggle'
            });
            this.cleanups.push(listen(moreEl, 'click', () => {
                // Add remaining items
                for (const doc of docs.slice(COLLAPSED_MAX)) {
                    const item = list.createEl('li');
                    const icon = doc.type === 'pdf' ? '📄' : '📎';
                    item.createEl('span', { text: `${icon} ${doc.displayName}` });
                    if (doc.sizeBytes != null && doc.sizeBytes > 0) {
                        item.createEl('span', {
                            text: ` (${formatBytes(doc.sizeBytes)})`,
                            cls: 'setting-item-description'
                        });
                    }
                }
                moreEl.remove();
            }));
        }

        // Upload notice callout
        const notice = section.createDiv({ cls: 'ai-organiser-notebooklm-callout ai-organiser-notebooklm-callout--info' });
        notice.createEl('p', {
            text: this.t.notebooklm?.sidecarNotice ||
                'NotebookLM reads charts and graphs from PDFs directly — upload them alongside your notes.'
        });
    }

    private renderUpdatePackButtons(setting: Setting): void {
        const mt = this.t.modals.notebookLMExport;

        if (this.preview.configChanged) {
            // Config changed — disable Update Pack
            const notice = this.contentEl.createDiv({ cls: 'ai-organiser-notebooklm-callout ai-organiser-notebooklm-callout--info' });
            notice.createEl('p', { text: this.t.notebooklm?.configChangedNotice || 'Export settings changed — full re-export required.' });

            setting.addButton(btn => {
                btn.setButtonText(mt.newPackButton || 'New pack').setCta();
                this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                    if (!this.isExporting) this.startExport('new');
                }));
            });
        } else {
            setting.addButton(btn => {
                btn.setButtonText(mt.newPackButton || 'New pack');
                this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                    if (!this.isExporting) this.startExport('new');
                }));
            });

            setting.addButton(btn => {
                btn.setButtonText(mt.updatePackButton || 'Update pack').setCta();
                this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                    if (!this.isExporting) this.startExport('update');
                }));
            });
        }
    }

    private startExport(mode: 'new' | 'update'): void {
        this.isExporting = true;

        if (this.progressContainer) {
            this.progressContainer.removeClass('ai-organiser-hidden');
        }

        // Update cancel button text
        if (this.cancelBtn) {
            this.cancelBtn.setText('Cancel');
            this.cancelBtn.disabled = false;
        }

        this.onSubmit(
            { proceed: true, mode, config: this.config },
            this.abortController.signal
        );
    }

    private renderSuccess(packFolderPath?: string, warnings?: string[]): void {
        if (this.isDisposed) return;
        const { contentEl } = this;
        contentEl.empty();
        this.cleanups = [];

        const mt = this.t.modals.notebookLMExport;

        contentEl.createEl('h2', { text: mt.title });

        // Progress bar at 100%
        const progDiv = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-progress' });
        const bar = new ProgressBarComponent(progDiv);
        bar.setValue(100);
        progDiv.createEl('p', {
            text: this.t.notebooklm?.exportComplete || 'Export complete!',
            cls: 'setting-item-description'
        });

        // Warnings (collapsible)
        if (warnings && warnings.length > 0) {
            const details = contentEl.createEl('details', { cls: 'ai-organiser-notebooklm-warnings-details' });
            details.createEl('summary', { text: `Warnings (${warnings.length})` });
            const ul = details.createEl('ul');
            for (const w of warnings) ul.createEl('li', { text: w });
        }

        const buttonsDiv = contentEl.createDiv({ cls: 'modal-button-container' });
        const btnSetting = new Setting(buttonsDiv);

        // Open folder (desktop) / path display (mobile)
        if (packFolderPath) {
            if (!Platform.isMobile) {
                btnSetting.addButton(btn => {
                    btn.setButtonText(mt.openFolderButton || 'Open folder').setCta();
                    this.cleanups.push(listen(btn.buttonEl, 'click', () => {
                        this.openFolderInSystem(packFolderPath);
                    }));
                });
            } else {
                // Mobile: show vault path as copyable text
                const pathDiv = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-mobile-path' });
                pathDiv.createEl('span', { text: 'Folder: ', cls: 'setting-item-description' });
                pathDiv.createEl('code', { text: packFolderPath });
                const copyBtn = pathDiv.createEl('button', {
                    text: 'Copy',
                    cls: 'ai-organiser-notebooklm-copy-btn'
                });
                this.cleanups.push(listen(copyBtn, 'click', () => {
                    void navigator.clipboard.writeText(packFolderPath).then(() => {
                        copyBtn.setText('Copied!');
                        setTimeout(() => { if (!this.isDisposed) copyBtn.setText('Copy'); }, 1500);
                    });
                }));
            }
        }

        btnSetting.addButton(btn => {
            btn.setButtonText('Close');
            this.cleanups.push(listen(btn.buttonEl, 'click', () => this.close()));
        });
    }

    private renderFailure(errorMessage?: string): void {
        if (this.isDisposed) return;
        const { contentEl } = this;
        contentEl.empty();
        this.cleanups = [];

        contentEl.createEl('h2', { text: this.t.modals.notebookLMExport.title });

        const errDiv = contentEl.createDiv({ cls: 'ai-organiser-notebooklm-callout ai-organiser-notebooklm-callout--error' });
        errDiv.createEl('p', { text: errorMessage || 'Export failed.' });

        new Setting(contentEl).addButton(btn => {
            btn.setButtonText('Close');
            this.cleanups.push(listen(btn.buttonEl, 'click', () => this.close()));
        });
    }

    private renderAborted(): void {
        if (this.isDisposed) return;
        const { contentEl } = this;
        contentEl.empty();
        this.cleanups = [];

        contentEl.createEl('h2', { text: this.t.modals.notebookLMExport.title });
        contentEl.createEl('p', {
            text: this.t.notebooklm?.exportAborted || 'Export cancelled.',
            cls: 'setting-item-description'
        });

        new Setting(contentEl).addButton(btn => {
            btn.setButtonText('Close');
            this.cleanups.push(listen(btn.buttonEl, 'click', () => this.close()));
        });
    }

    private openFolderInSystem(folderPath: string): void {
        try {
            const adapter = this.app.vault.adapter as { getBasePath?: () => string };
            const basePath = adapter.getBasePath?.() ?? '';
            const fullPath = `${basePath}/${folderPath}`;
            const electron = getElectron();
            void electron?.shell?.openPath?.(fullPath);
        } catch {
            // Silently ignore — user can navigate manually
        }
    }
}
