/**
 * QuickPeekModal
 * Phase-based modal: detecting → extracting → triaging → done
 * Shows a triage card per embedded source with actions.
 */

import { ButtonComponent, Editor, Modal, Notice, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { DetectedContent } from '../../utils/embeddedContentDetector';
import type { QuickPeekSource } from '../../services/quickPeekService';
import { QuickPeekService } from '../../services/quickPeekService';
import { ensurePrivacyConsent } from '../../services/privacyNotice';
import { openInBrowser } from '../../services/webContentService';
import { removeProcessedSources } from '../../utils/sourceDetection';
import { insertOrReplaceQuickPeekSection } from '../../utils/editorUtils';
import { openQuickPeekFullSummary } from '../../commands/summarizeCommands';

type Phase = 'detecting' | 'extracting' | 'triaging' | 'done';

const CONTENT_TYPE_ICON: Record<string, string> = {
    'web-link': 'globe',
    youtube: 'youtube',
    pdf: 'file-text',
    document: 'file-spreadsheet',
    audio: 'music'
};

export class QuickPeekModal extends Modal {
    private phase: Phase = 'detecting';
    private sources: QuickPeekSource[] = [];
    private progressCurrent = 0;
    private progressTotal = 0;
    private progressLabel = '';
    private abortController: AbortController | null = null;

    constructor(
        private readonly plugin: AIOrganiserPlugin,
        private readonly items: DetectedContent[],
        private readonly editor: Editor
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.abortController = new AbortController();
        this.modalEl.addClass('ai-organiser-quick-peek-modal');
        // Single-source fast path: skip 'detecting' label — go straight to extracting
        if (this.items.length === 1) this.phase = 'extracting';
        this.render();
        void this.runPipeline();
    }

    onClose(): void {
        this.abortController?.abort();
        this.abortController = null;
    }

    // ── Pipeline ──────────────────────────────────────────────────────────

    private async runPipeline(): Promise<void> {
        const effectiveProvider = this.plugin.settings.quickPeekProvider === 'main'
            ? (this.plugin.settings.serviceType === 'cloud' ? this.plugin.settings.cloudServiceType : 'local')
            : this.plugin.settings.quickPeekProvider;

        const proceed = await ensurePrivacyConsent(this.plugin, effectiveProvider);
        if (!proceed || this.abortController?.signal.aborted) {
            this.close();
            return;
        }

        this.phase = 'extracting';
        this.progressTotal = this.items.length;
        this.render();

        const service = new QuickPeekService(this.app, this.plugin);
        const result = await service.triageSources(
            this.items,
            (current, total, item) => {
                this.phase = current <= total / 2 ? 'extracting' : 'triaging';
                this.progressCurrent = current;
                this.progressTotal = total;
                this.progressLabel = item.displayName;
                this.render();
            },
            this.abortController?.signal
        );

        if (this.abortController?.signal.aborted) return;

        this.sources = result.sources;
        this.phase = 'done';
        this.render();
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    private render(): void {
        this.contentEl.empty();

        // Title
        this.titleEl.setText('Quick peek');

        if (this.phase !== 'done') {
            this.renderProgress();
        } else {
            this.renderResults();
        }
    }

    private renderProgress(): void {
        const t = this.plugin.t;
        const phaseLabels: Record<Phase, string> = {
            detecting: t.messages.quickPeekDetecting,
            extracting: t.messages.quickPeekExtracting,
            triaging: t.messages.quickPeekTriaging,
            done: t.messages.quickPeekComplete
        };

        const wrap = this.contentEl.createDiv({ cls: 'ai-organiser-quick-peek-progress' });
        wrap.createEl('p', { text: phaseLabels[this.phase], cls: 'ai-organiser-quick-peek-phase-label' });

        if (this.progressTotal > 0) {
            const bar = wrap.createDiv({ cls: 'ai-organiser-quick-peek-bar-wrap' });
            const fill = bar.createDiv({ cls: 'ai-organiser-quick-peek-bar-fill ai-organiser-dynamic-width' });
            fill.setCssProps({ '--dynamic-width': `${Math.round((this.progressCurrent / this.progressTotal) * 100)}%` });
            wrap.createEl('p', {
                text: `${this.progressCurrent} / ${this.progressTotal}${this.progressLabel ? ` — ${this.progressLabel}` : ''}`,
                cls: 'ai-organiser-quick-peek-progress-text'
            });
        }
    }

    private renderResults(): void {
        const t = this.plugin.t;
        if (this.sources.length === 0) {
            this.contentEl.createEl('p', { text: t.commands.quickPeekNoSources });
            return;
        }

        const cards = this.contentEl.createDiv({ cls: 'ai-organiser-quick-peek-cards' });
        for (const source of this.sources) {
            this.renderCard(cards, source);
        }

        // Insert All Peeks footer action
        const footer = this.contentEl.createDiv({ cls: 'ai-organiser-quick-peek-footer' });
        new ButtonComponent(footer)
            .setButtonText(t.commands.quickPeek + ' — Insert All')
            .setCta()
            .onClick(() => {
                this.insertAllPeeks();
            });
    }

    private renderCard(container: HTMLElement, source: QuickPeekSource): void {
        const t = this.plugin.t;
        const card = container.createDiv({ cls: 'ai-organiser-quick-peek-card' });

        // Card header: icon + display name
        const header = card.createDiv({ cls: 'ai-organiser-quick-peek-card-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-quick-peek-card-icon' });
        const icon = CONTENT_TYPE_ICON[source.detected.type] ?? 'file';
        setIcon(iconEl, icon);
        header.createSpan({ text: source.detected.displayName, cls: 'ai-organiser-quick-peek-card-title' });

        // Summary or error
        const body = card.createDiv({ cls: 'ai-organiser-quick-peek-card-body' });
        if (source.triageSummary) {
            if (source.llmFailed) {
                body.createEl('p', { text: '⚠ ' + source.triageSummary, cls: 'ai-organiser-quick-peek-excerpt' });
            } else {
                body.createEl('p', { text: source.triageSummary, cls: 'ai-organiser-quick-peek-summary' });
            }
        } else if (source.extractionError) {
            body.createEl('p', { text: '⚠ ' + source.extractionError, cls: 'ai-organiser-quick-peek-error' });
        }

        // Actions
        const actions = card.createDiv({ cls: 'ai-organiser-quick-peek-card-actions' });

        // Full Summary button — opens MultiSourceModal with this source pre-filled and a working summarize callback
        new ButtonComponent(actions)
            .setButtonText(t.modals.multiSource.summarizeButton)
            .onClick(() => {
                openQuickPeekFullSummary(this.plugin, this.editor, source.detected.originalText);
                this.close();
            });

        // Open button
        new ButtonComponent(actions)
            .setButtonText('Open')
            .onClick(() => {
                this.openSource(source.detected);
            });

        // Remove from Note button
        new ButtonComponent(actions)
            .setButtonText('Remove from note')
            .onClick(() => {
                this.removeFromNote(source, card);
            });
    }

    // ── Actions ───────────────────────────────────────────────────────────

    private openSource(detected: DetectedContent): void {
        if (detected.isExternal) {
            openInBrowser(detected.url);
        } else {
            void this.app.workspace.openLinkText(detected.url, '');
        }
    }

    private removeFromNote(source: QuickPeekSource, cardEl: HTMLElement): void {
        const originalContent = this.editor.getValue();
        // Split external URLs from vault file paths — removeProcessedSources handles each differently
        const urls = source.detected.isExternal ? [source.detected.url] : [];
        const vaultFiles = source.detected.isExternal ? undefined : [source.detected.url];
        const cleaned = removeProcessedSources(originalContent, urls, vaultFiles);
        this.editor.setValue(cleaned);

        // Prune from sources so Insert All Peeks doesn't re-insert removed items
        this.sources = this.sources.filter(s => s !== source);

        // Remove card from modal
        cardEl.remove();

        // 5s undo notice
        const notice = new Notice('Source removed. Click to undo.', 5000);
        notice.messageEl.addEventListener('click', () => {
            this.editor.setValue(originalContent);
            notice.hide();
        });
    }

    private insertAllPeeks(): void {
        const t = this.plugin.t;
        const lines: string[] = ['## Quick Peek', ''];
        for (const source of this.sources) {
            lines.push(`### ${source.detected.displayName}`);
            lines.push(`> ${source.detected.url}`);
            lines.push('');
            if (source.triageSummary) {
                lines.push(source.triageSummary);
            } else if (source.extractionError) {
                lines.push(`_⚠ ${source.extractionError}_`);
            }
            lines.push('');
        }

        insertOrReplaceQuickPeekSection(this.editor, lines.join('\n'));
        new Notice(t.messages.quickPeekInserted);
        this.close();
    }
}
