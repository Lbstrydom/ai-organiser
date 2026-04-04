/**
 * Presentation Mode Handler
 *
 * Chat mode for building HTML slide decks. LLM generates HTML with branded CSS,
 * previewed in a sandboxed iframe. On approval, dom-to-pptx exports the rendered
 * DOM to editable PPTX. Optional Haiku brand audit applies surgical DOM fixes.
 *
 * State machine: empty → generating → preview-ready → refining → preview-ready
 *                       → error
 *                preview-ready → exporting → preview-ready
 *                              → auditing → preview-ready
 *                any → empty (discard / clear)
 */

import { Notice } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type {
    ChatModeHandler, ChatMode, ModalContext, SendResult,
    ActionDescriptor, ActionCallbacks,
} from './ChatModeHandler';
import { pluginContext } from '../../services/llmFacade';
import type { LLMFacadeContext } from '../../services/llmFacade';
import {
    type PresentationPhase, type PresentationVersion, type QualityResult,
    MAX_VERSIONS, extractSlideInfo, runStructureChecks, computeQualityScore,
    migratePresentationSession,
} from '../../services/chat/presentationTypes';
import { generateHtml, refineHtml, runBrandAudit } from '../../services/chat/presentationHtmlService';
import {
    isBrandAvailable, resolveTheme,
    type BrandTheme,
} from '../../services/chat/brandThemeService';
import { extractDeckTitle, countSlides } from '../../services/prompts/presentationChatPrompts';
import { SlideIframePreview } from '../components/SlideIframePreview';
import { getMaxContentCharsForModel, truncateAtBoundary } from '../../services/tokenLimits';
import { logger } from '../../utils/logger';

export class PresentationModeHandler implements ChatModeHandler {
    readonly mode: ChatMode = 'presentation';

    // State
    private phase: PresentationPhase = 'empty';
    private html: string | null = null;
    private versions: PresentationVersion[] = [];
    private versionIndex = -1;
    private activeSlideIndex = 0;
    private lastError: string | null = null;
    private qualityResult: QualityResult | null = null;

    // Brand
    private brandEnabled = false;
    private brandTheme: BrandTheme | null = null;
    private brandAvailable = false;

    // Concurrency
    private activeAbort: AbortController | null = null;
    private mutationLock = false;

    // Preview
    private preview: SlideIframePreview | null = null;

    // ── ChatModeHandler interface ───────────────────────────────────────────

    isAvailable(ctx: ModalContext): boolean {
        return !!ctx.plugin.llmService;
    }

    unavailableReason(t: Translations): string {
        return t.modals.unifiedChat.presentationUnavailable;
    }

    getIntroMessage(t: Translations): string {
        return t.modals.unifiedChat.introPresentation;
    }

    getPlaceholder(t: Translations): string {
        return t.modals.unifiedChat.placeholderPresentation;
    }


    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        container.empty();

        // Check brand availability
        this.brandAvailable = isBrandAvailable(ctx.app, ctx.plugin.settings);

        // Brand toggle — always shown, disabled with instructions if no file
        this.renderBrandToggle(container, ctx);

        if (this.phase === 'empty') return;

        // Slide preview
        if (this.html) {
            const previewContainer = container.createEl('div', { cls: 'ai-organiser-pres-preview-container' });
            this.preview = new SlideIframePreview(previewContainer, {
                onSlideSelect: (idx) => { this.activeSlideIndex = idx; },
            });
            this.preview.setHtml(this.html);
            if (this.activeSlideIndex > 0) {
                // Defer navigation until iframe loads
                setTimeout(() => this.preview?.navigateToSlide(this.activeSlideIndex), 200);
            }
            if (this.qualityResult) {
                this.preview.setQuality(this.qualityResult);
            }
        }

        // Version navigation
        if (this.versions.length > 1) {
            this.renderVersionNav(container);
        }

        // Phase status
        if (this.phase === 'generating' || this.phase === 'refining') {
            container.createEl('div', {
                cls: 'ai-organiser-pres-status',
                text: this.phase === 'generating' ? 'Generating slides...' : 'Refining...',
            });
        }
        if (this.phase === 'exporting') {
            container.createEl('div', { cls: 'ai-organiser-pres-status', text: 'Exporting...' });
        }
        if (this.phase === 'auditing') {
            container.createEl('div', { cls: 'ai-organiser-pres-status', text: 'Checking brand compliance...' });
        }
        if (this.phase === 'error' && this.lastError) {
            const el = container.createEl('div', { cls: 'ai-organiser-pres-error' });
            el.textContent = this.lastError;
        }
    }

    async buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        if (this.mutationLock) {
            return { prompt: '', directResponse: 'Please wait for the current operation to complete.' };
        }

        this.cancelActiveOperation();
        this.mutationLock = true;
        const abort = new AbortController();
        this.activeAbort = abort;

        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);
            const noteContent = this.truncateNoteContent(ctx);

            if (!this.html) {
                // Initial generation
                this.phase = 'generating';

                const result = await generateHtml(llmCtx, {
                    userQuery: query,
                    noteContent,
                    conversationHistory: history,
                    outputLanguage: ctx.plugin.settings.summaryLanguage,
                    theme,
                    signal: abort.signal,
                });

                if (abort.signal.aborted) return { prompt: '', directResponse: 'Operation cancelled.' };

                if (!result.ok) {
                    this.phase = 'error';
                    this.lastError = result.error;
                    return { prompt: '', directResponse: `Failed to generate: ${result.error}` };
                }

                this.html = result.value;
                this.activeSlideIndex = 0;
                this.pushVersion(query);

                // Run initial brand audit if enabled
                if (this.brandEnabled && theme.auditChecklist.length > 0) {
                    await this.runAudit(llmCtx, theme, abort.signal);
                }

                this.runQualityCheck();
                this.phase = 'preview-ready';

                const title = extractDeckTitle(this.html);
                const count = countSlides(this.html);
                return {
                    prompt: '',
                    directResponse: `Created "${title}" with ${count} slides. Describe changes to refine, or export when ready.`,
                };
            } else {
                // Refinement
                this.phase = 'refining';

                const result = await refineHtml(llmCtx, {
                    currentHtml: this.html,
                    userRequest: query,
                    conversationHistory: history,
                    outputLanguage: ctx.plugin.settings.summaryLanguage,
                    theme,
                    signal: abort.signal,
                });

                if (abort.signal.aborted) return { prompt: '', directResponse: 'Operation cancelled.' };

                if (!result.ok) {
                    this.phase = 'error';
                    this.lastError = result.error;
                    return { prompt: '', directResponse: `Failed to refine: ${result.error}` };
                }

                this.html = result.value;
                this.pushVersion(query);
                this.runQualityCheck();
                this.phase = 'preview-ready';

                const count = countSlides(this.html);
                return {
                    prompt: '',
                    directResponse: `Updated. ${count} slides. Continue refining or export.`,
                };
            }
        } finally {
            this.mutationLock = false;
        }
    }

    getActionDescriptors(_t: Translations): ActionDescriptor[] {
        const hasDeck = !!this.html;
        const ready = this.phase === 'preview-ready';
        const locked = this.mutationLock;

        const actions: ActionDescriptor[] = [
            {
                id: 'export-pptx',
                labelKey: 'Export PPTX',
                tooltipKey: 'Export as editable PowerPoint file via dom-to-pptx',
                isEnabled: hasDeck && ready && !locked,
            },
            {
                id: 'export-html',
                labelKey: 'Export HTML',
                tooltipKey: 'Save as self-contained HTML presentation',
                isEnabled: hasDeck && ready && !locked,
            },
        ];

        // Brand audit button only if brand is enabled
        if (this.brandEnabled && this.brandAvailable) {
            actions.push({
                id: 'check-brand',
                labelKey: 'Check Brand',
                tooltipKey: 'Run brand compliance audit and fix violations',
                isEnabled: hasDeck && ready && !locked,
            });
        }

        actions.push(
            {
                id: 'polish',
                labelKey: 'Polish',
                tooltipKey: 'Run quality checks and refine',
                isEnabled: hasDeck && ready && !locked,
            },
            {
                id: 'discard',
                labelKey: 'Discard',
                tooltipKey: 'Discard current presentation',
                isEnabled: hasDeck && !locked,
            },
        );

        return actions;
    }

    async handleAction(actionId: string, ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        switch (actionId) {
            case 'export-pptx': return this.exportPptx(ctx, callbacks);
            case 'export-html': return this.exportHtmlFile(ctx, callbacks);
            case 'check-brand': return this.handleBrandAudit(ctx, callbacks);
            case 'polish': return this.handlePolish(ctx, callbacks);
            case 'discard': return this.handleDiscard(callbacks);
        }
    }

    onClear(): void {
        this.cancelActiveOperation();
        this.html = null;
        this.versions = [];
        this.versionIndex = -1;
        this.activeSlideIndex = 0;
        this.qualityResult = null;
        this.lastError = null;
        this.phase = 'empty';
    }

    dispose(): void {
        this.cancelActiveOperation();
        this.preview?.dispose();
        this.preview = null;
    }

    // ── Serialization ───────────────────────────────────────────────────────

    getSerializableState(): Record<string, unknown> | null {
        if (!this.html) return null;
        return {
            schemaVersion: 1,
            html: this.html,
            versions: this.versions,
            conversation: [],
            brandEnabled: this.brandEnabled,
            createdAt: this.versions[0]?.timestamp
                ? new Date(this.versions[0].timestamp).toISOString()
                : new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
        };
    }

    restoreState(data: unknown): boolean {
        const session = migratePresentationSession(data);
        if (!session) return false;

        this.html = session.html;
        this.versions = session.versions.slice(0, MAX_VERSIONS);
        this.versionIndex = this.versions.length - 1;
        this.brandEnabled = session.brandEnabled;
        this.activeSlideIndex = 0;
        this.phase = 'preview-ready';
        return true;
    }

    // ── Export: PPTX via dom-to-pptx ────────────────────────────────────────

    private async exportPptx(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || !this.preview || this.mutationLock) return;
        this.mutationLock = true;
        this.phase = 'exporting';
        callbacks.rerenderActions();

        try {
            const iframeDoc = this.preview.getIframeDocument();
            if (!iframeDoc) throw new Error('iframe not ready');

            // Show all slides for export (remove nav-hidden class)
            const allSlides = iframeDoc.querySelectorAll('.slide');
            allSlides.forEach(s => s.classList.remove('pres-nav-hidden'));

            const { exportToPptx } = await import('dom-to-pptx');
            await exportToPptx(Array.from(allSlides) as HTMLElement[], {
                fileName: sanitizeFileName(extractDeckTitle(this.html)) + '.pptx',
            });

            // Restore single-slide view
            this.preview.navigateToSlide(this.activeSlideIndex);

            callbacks.addSystemNotice('PPTX exported — check your downloads folder.');
            new Notice('PPTX exported');
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.addSystemNotice(`PPTX export failed: ${msg}`);
            logger.error('Presentation', `PPTX export failed: ${msg}`);
        } finally {
            this.phase = 'preview-ready';
            this.mutationLock = false;
            callbacks.rerenderActions();
        }
    }

    // ── Export: HTML ─────────────────────────────────────────────────────────

    private async exportHtmlFile(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || this.mutationLock) return;
        this.mutationLock = true;
        this.phase = 'exporting';
        callbacks.rerenderActions();

        try {
            const title = extractDeckTitle(this.html);
            const folder = this.getOutputFolder(ctx);
            const fileName = sanitizeFileName(title) + '.html';
            const path = await getAvailablePath(ctx, folder, fileName);

            await ctx.app.vault.create(path, this.html);
            callbacks.addSystemNotice(`Saved to ${path}`);
            new Notice(`Saved: ${path}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.addSystemNotice(`HTML export failed: ${msg}`);
        } finally {
            this.phase = 'preview-ready';
            this.mutationLock = false;
            callbacks.rerenderActions();
        }
    }

    // ── Brand Audit ─────────────────────────────────────────────────────────

    private async handleBrandAudit(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || !this.brandEnabled || this.mutationLock) return;
        this.mutationLock = true;
        this.phase = 'auditing';
        callbacks.showThinking();
        callbacks.rerenderActions();

        const abort = new AbortController();
        this.activeAbort = abort;

        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);

            const result = await runBrandAudit(llmCtx, this.html, theme, abort.signal);
            if (abort.signal.aborted) return;

            if (result.ok && result.value.violations.length > 0) {
                this.preview?.applyDomFixes(result.value.violations);
                callbacks.addSystemNotice(
                    `Brand audit: ${result.value.violations.length} fix(es) applied.`
                );
            } else if (result.ok) {
                callbacks.addSystemNotice('Brand audit: all checks passed.');
            }

            this.runQualityCheck(result.ok ? result.value.violations.length : 0);
            this.phase = 'preview-ready';
        } catch (e) {
            if (!abort.signal.aborted) {
                this.phase = 'error';
                this.lastError = e instanceof Error ? e.message : 'Audit failed';
            }
        } finally {
            this.mutationLock = false;
            callbacks.hideThinking();
            callbacks.rerenderActions();
        }
    }

    private async runAudit(llmCtx: LLMFacadeContext, theme: BrandTheme, signal: AbortSignal): Promise<void> {
        if (!this.html) return;
        const result = await runBrandAudit(llmCtx, this.html, theme, signal);
        if (result.ok && result.value.violations.length > 0 && this.preview) {
            // Fixes will be applied once preview renders
            // Store for later application
            this.pendingFixes = result.value.violations;
        }
    }

    private pendingFixes: import('../../services/chat/presentationTypes').DomFix[] = [];

    // ── Polish ──────────────────────────────────────────────────────────────

    private async handlePolish(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || this.mutationLock) return;
        this.mutationLock = true;
        this.phase = 'refining';
        callbacks.showThinking();
        callbacks.rerenderActions();

        const abort = new AbortController();
        this.activeAbort = abort;

        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);
            const maxPasses = ctx.plugin.settings.aichatRefinementPasses || 1;

            for (let pass = 0; pass < maxPasses; pass++) {
                if (abort.signal.aborted) break;

                // Quality check
                this.runQualityCheck();
                if (this.qualityResult && this.qualityResult.totalScore >= 80 && pass > 0) break;

                // Build polish request from findings
                const findings = this.qualityResult?.findings || [];
                if (findings.length === 0) break;

                const polishRequest = findings
                    .map(f => `[${f.severity}] ${f.slideIndex !== undefined ? `Slide ${f.slideIndex + 1}: ` : ''}${f.issue} → ${f.suggestion}`)
                    .join('\n');

                const result = await refineHtml(llmCtx, {
                    currentHtml: this.html,
                    userRequest: `Polish the presentation. Fix these issues:\n${polishRequest}`,
                    outputLanguage: ctx.plugin.settings.summaryLanguage,
                    theme,
                    signal: abort.signal,
                });

                if (abort.signal.aborted) break;

                if (result.ok) {
                    this.html = result.value;
                    this.pushVersion(`Polish pass ${pass + 1}`);
                }
            }

            // Run brand audit if enabled
            if (this.brandEnabled && theme.auditChecklist.length > 0 && !abort.signal.aborted) {
                await this.runAudit(llmCtx, theme, abort.signal);
            }

            this.runQualityCheck();
            this.phase = 'preview-ready';
            callbacks.addSystemNotice(
                `Polish complete. Quality: ${this.qualityResult?.totalScore ?? '?'}/100`
            );
        } catch (e) {
            if (!abort.signal.aborted) {
                this.phase = 'error';
                this.lastError = e instanceof Error ? e.message : 'Polish failed';
                callbacks.addSystemNotice(`Polish failed: ${this.lastError}`);
            }
        } finally {
            this.mutationLock = false;
            callbacks.hideThinking();
            callbacks.rerenderActions();
        }
    }

    private handleDiscard(callbacks: ActionCallbacks): void {
        this.onClear();
        callbacks.addSystemNotice('Presentation discarded.');
        callbacks.rerenderActions();
    }

    // ── Version History ─────────────────────────────────────────────────────

    private pushVersion(userPrompt: string): void {
        if (!this.html) return;
        this.versions.push({
            html: this.html,
            userPrompt,
            timestamp: Date.now(),
            activeSlideIndex: this.activeSlideIndex,
        });
        if (this.versions.length > MAX_VERSIONS) this.versions.shift();
        this.versionIndex = this.versions.length - 1;
    }

    private restoreVersion(index: number): void {
        if (index < 0 || index >= this.versions.length) return;
        const version = this.versions[index];
        this.html = version.html;
        this.activeSlideIndex = version.activeSlideIndex;
        this.versionIndex = index;
        this.phase = 'preview-ready';
    }

    private renderVersionNav(container: HTMLElement): void {
        const nav = container.createEl('div', { cls: 'ai-organiser-pres-version-nav' });

        const prevBtn = nav.createEl('button', { cls: 'ai-organiser-pres-version-btn', text: '◄ Prev' }); // eslint-disable-line obsidianmd/ui/sentence-case
        prevBtn.disabled = this.versionIndex <= 0;
        prevBtn.addEventListener('click', () => this.restoreVersion(this.versionIndex - 1));

        nav.createEl('span', {
            cls: 'ai-organiser-pres-version-counter',
            text: `v${this.versionIndex + 1}/${this.versions.length}`,
        });

        const nextBtn = nav.createEl('button', { cls: 'ai-organiser-pres-version-btn', text: 'Next ►' });
        nextBtn.disabled = this.versionIndex >= this.versions.length - 1;
        nextBtn.addEventListener('click', () => this.restoreVersion(this.versionIndex + 1));
    }

    // ── Brand Toggle ────────────────────────────────────────────────────────

    private renderBrandToggle(container: HTMLElement, ctx: ModalContext): void {
        const toggle = container.createEl('div', { cls: 'ai-organiser-pres-brand-toggle' });

        if (this.brandAvailable) {
            // Brand file exists — show functional toggle
            const label = toggle.createEl('label', { cls: 'ai-organiser-pres-brand-label' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.brandEnabled;
            checkbox.addEventListener('change', () => {
                this.brandEnabled = checkbox.checked;
                this.brandTheme = null;
            });
            label.createEl('span', { text: ' On-brand' });
        } else {
            // No brand file — show instructions
            toggle.addClass('is-disabled');
            const label = toggle.createEl('label', { cls: 'ai-organiser-pres-brand-label' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = false;
            checkbox.disabled = true;
            label.createEl('span', { text: ' On-brand' });

            const configFolder = ctx.plugin.settings.configFolderPath || 'Config';
            const hint = toggle.createEl('div', { cls: 'ai-organiser-pres-brand-hint' });
            hint.textContent = `Create ${ctx.plugin.settings.pluginFolder}/${configFolder}/brand-guidelines.md to enable`;
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private getLLMContext(ctx: ModalContext): LLMFacadeContext {
        return pluginContext(ctx.fullPlugin as any);
    }

    private async getTheme(ctx: ModalContext): Promise<BrandTheme> {
        if (this.brandTheme) return this.brandTheme;
        this.brandTheme = await resolveTheme(ctx.app, ctx.plugin.settings, this.brandEnabled);
        return this.brandTheme;
    }

    private cancelActiveOperation(): void {
        if (this.activeAbort) {
            this.activeAbort.abort();
            this.activeAbort = null;
        }
    }

    private truncateNoteContent(ctx: ModalContext): string | undefined {
        const content = ctx.options.noteContent;
        if (!content) return undefined;
        const provider = ctx.plugin.settings.cloudServiceType;
        const model = ctx.plugin.settings.cloudModel;
        const budget = Math.floor(getMaxContentCharsForModel(provider, model) * 0.20);
        return content.length > budget
            ? truncateAtBoundary(content, budget, '\n\n[Content truncated...]')
            : content;
    }

    private runQualityCheck(auditViolationCount = 0): void {
        if (!this.html || !this.preview) {
            this.qualityResult = null;
            return;
        }
        const doc = this.preview.getIframeDocument();
        if (!doc) return;
        const slides = extractSlideInfo(doc);
        const findings = runStructureChecks(slides);
        this.qualityResult = computeQualityScore(findings, auditViolationCount);
    }

    private getOutputFolder(ctx: ModalContext): string {
        const sub = ctx.plugin.settings.presentationOutputFolder || 'Presentations';
        return `${ctx.plugin.settings.pluginFolder}/${sub}`;
    }
}

// ── File Utilities ──────────────────────────────────────────────────────────

function sanitizeFileName(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, '-').replace(/-+/g, '-').trim() || 'Presentation';
}

async function getAvailablePath(ctx: ModalContext, folder: string, fileName: string): Promise<string> {
    if (!ctx.app.vault.getAbstractFileByPath(folder)) {
        await ctx.app.vault.createFolder(folder);
    }
    const base = `${folder}/${fileName}`;
    if (!ctx.app.vault.getAbstractFileByPath(base)) return base;

    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    for (let i = 1; i < 999; i++) {
        const candidate = `${folder}/${stem} (${i})${ext}`;
        if (!ctx.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return base;
}
