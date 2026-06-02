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
    StreamingCallbacks, StreamingResult,
} from './ChatModeHandler';
import { pluginContext } from '../../services/llmFacade';
import type { LLMFacadeContext } from '../../services/llmFacade';
import {
    type PresentationPhase, type PresentationVersion, type QualityResult,
    type SelectionScope, type EditMode, type EditFlags,
    MAX_VERSIONS, extractSlideInfo, runStructureChecks, computeQualityScore,
    migratePresentationSession, classifyReliability,
} from '../../services/chat/presentationTypes';
import { runBrandAudit, generateDeckIr, refineDeckIr, buildHtmlFromDeckIr } from '../../services/chat/presentationHtmlService';
import type { SlideDeckIr } from '../../services/presentationIr/slideIr';
import { validateDeckIr } from '../../services/presentationIr/slideIr';
import type { ExportTheme } from '../../services/export/exportTheme';
import { projectForEditor } from '../../services/chat/presentationDomDecorator';
import { ResearchSearchService } from '../../services/research/researchSearchService';
import { PolishSelectorModal, type PolishSubmit } from '../modals/PolishSelectorModal';
import { refineDeckIrSelective, parseRefineErrorCode } from '../../services/chat/refineDeckIrSelective';
import { withProgressResult } from '../../services/progress';
import { ok, err } from '../../core/result';
import { renderEditAccessories } from './presentation/EditAccessories';
import { renderCreatePanel } from './presentation/CreatePanel';
import { PresentationSourceService, DEFAULT_CREATION_CONFIG } from '../../services/chat/presentationSourceService';
import { CreationSourceController } from '../../services/chat/creationSourceController';
import { computeSourceBudgetChars } from '../../services/chat/presentationSourceBudget';
import type { CreationConfig, PromptSource } from '../../services/chat/presentationTypes';
import { runFastScan, deduplicateFindings } from '../../services/chat/presentationQualityService';
import { sanitizePresentation } from '../../services/chat/presentationSanitizer';
import { LongRunningOpController } from '../../services/longRunningOp/progressController';
import {
    GENERATION_SOFT_BUDGET_MS, GENERATION_HARD_BUDGET_MS,
    REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS,
} from '../../services/chat/presentationConstants';
import {
    isBrandAvailable, resolveTheme,
    type BrandTheme,
} from '../../services/chat/brandThemeService';
import { extractDeckTitle, countSlides } from '../../services/prompts/presentationChatPrompts';
import { SlideIframePreview } from '../components/SlideIframePreview';
import { getMaxContentCharsForModel, truncateAtBoundary } from '../../services/tokenLimits';
import { logger } from '../../utils/logger';
import type { ProjectConfig } from '../../services/chat/projectService';

/** Bundled params for the runGenerate/runRefine helpers — keeps method
 *  signatures under the max-param lint threshold. */
interface RunContext {
    ctx: ModalContext;
    streamCb: StreamingCallbacks;
    abort: AbortController;
    llmCtx: LLMFacadeContext;
    theme: BrandTheme;
    effectiveQuery: string;
    history: string;
    originalQuery: string;
    noteContent: string | undefined;
}

export class PresentationModeHandler implements ChatModeHandler {
    readonly mode: ChatMode = 'presentation';

    /** Singleton tracker for global commands (e.g. Mod+Shift+S slide picker)
     *  to find the currently-mounted handler. Set in renderContextPanel,
     *  cleared in dispose. Most-recently-mounted wins when multiple modals
     *  exist (rare). */
    private static activeInstance: PresentationModeHandler | null = null;

    static getActiveInstance(): PresentationModeHandler | null {
        return PresentationModeHandler.activeInstance;
    }

    // State
    private phase: PresentationPhase = 'empty';
    private html: string | null = null;
    // `deckIr` is the canonical artifact — the deck is always IR-backed (legacy
    // HTML generation was retired 2026-06). Every mutation path produces a new
    // IR via commitDeckMutation, so it never disagrees with `this.html`.
    private deckIr: SlideDeckIr | null = null;
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
    // Single-flight guard for the per-slide polish modal: while a modal is
    // open, a second Polish click is a no-op rather than opening a duplicate
    // (audit-r2 H3). Cleared from the modal's onClose (audit-r3 H3).
    private activePolish: { modal: PolishSelectorModal } | null = null;

    // Phase-progress: when an async action wires this, setPhase() bubbles
    // human-readable labels into the chat "Thinking…" placeholder so users
    // don't stare at silent spinner. Cleared in finally blocks.
    private activeThinkingUpdater: ((msg: string) => void) | null = null;

    // Extend-card cleanup: modal registers its dismiss function via
    // StreamingCallbacks.requestBudgetExtension.onRegisterCancelHook so the
    // controller can auto-close the card on completion / hard cap (plan §4
    // race protocol, sources 4-5). Nulled after use.
    private pendingCancelHook: (() => void) | null = null;

    // Cached slide fragment for the 1s elapsed ticker — lets the ticker
    // re-render progress without clobbering the slide-count text the
    // previous checkpoint wrote to the live region.
    private lastSlideFragment = '';

    // F4: cached translations for the period an async op owns the handler,
    // so phase labels + mutex-lock copy can i18n without threading ctx
    // through every internal helper. Populated in buildPrompt / action
    // handlers, cleared in their finally blocks.
    private activeT: Translations['modals']['unifiedChat'] | null = null;

    // F5: tracked handle for the navigate-to-slide deferral so rapid
    // re-renders / dispose clean it up instead of letting stale callbacks
    // fire on a torn-down preview.
    private navigateTimeoutId: ReturnType<typeof setTimeout> | null = null;
    /** Stable host for the version nav so restoreVersion can re-render it. */
    private versionNavHost: HTMLElement | null = null;

    // Project context
    private projectInstructions: string | null = null;
    private projectMemory: string[] = [];

    // Preview
    private preview: SlideIframePreview | null = null;

    // ── Scoped editing (slide-authoring-editing plan) ───────────────────────
    // Selection: null = whole-deck edit (existing Polish path); else the
    //            iframe-clicked or slide-pill-clicked scope.
    // editMode:  'content' (default) edits text/data; 'design' edits layout
    //            without rewriting text. Hidden when no selection.
    // editFlags: web search + reference notes — content mode only.
    private selection: SelectionScope | null = null;
    private editMode: EditMode = 'content';
    private editFlags: EditFlags = { webSearch: false, references: [] };

    // Container handles for the chat-input accessory area (selection pill
    // + mode pills). Cleared in dispose() / onClear() and rebound in
    // renderChatInputAccessory().
    private accessoryContainer: HTMLElement | null = null;

    // Translations stashed when renderContextPanel runs — refreshAccessory
    // reads from here. Stays alive between renders; nulled in dispose.
    private accessoryT: Translations['modals']['unifiedChat'] | null = null;

    // ── Create-flow source state (slide-authoring-followup plan) ────────────
    // Lazily instantiated on first renderContextPanel call so we have access
    // to `ctx.app`. Disposed in `dispose()`. Subscription unsubscribe stored
    // for teardown when the create panel is replaced by the iframe.
    private sourceController: CreationSourceController | null = null;
    private creationFlowEpoch = 1;
    private creationConfig: CreationConfig = { ...DEFAULT_CREATION_CONFIG };
    private createPanelDispose: (() => void) | null = null;

    // ── Phase progress ──────────────────────────────────────────────────────

    /** Centralized phase setter that bubbles a phase-specific message to the
     *  chat "Thinking…" placeholder when an async action is active.
     *  Also calls `refreshAccessory()` so the create panel / edit pills
     *  reflect the new operation gate (audit Item 5). */
    private setPhase(phase: PresentationPhase): void {
        this.phase = phase;
        const label = this.getPhaseMessage(phase);
        if (label && this.activeThinkingUpdater) {
            this.activeThinkingUpdater(label);
        }
        this.refreshAccessory();
    }

    /** Human-readable label per presentation phase. Returns null for phases
     *  the user shouldn't see a thinking text for. (F4 — i18n-driven, falls
     *  back to English if no `activeT` has been registered yet.) */
    private getPhaseMessage(phase: PresentationPhase): string | null {
        const t = this.activeT;
        switch (phase) {
            case 'generating':   return t?.phaseGenerating ?? 'Generating slides…';
            case 'refining':     return t?.phaseRefining   ?? 'Refining presentation…';
            case 'auditing':     return t?.phaseAuditing   ?? 'Checking brand compliance…';
            case 'exporting':    return t?.phaseExporting  ?? 'Exporting…';
            case 'empty':
            case 'preview-ready':
            case 'error':
                return null;
        }
    }

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
        // Phase 1B F13: once a deck exists, placeholder pivots from
        // "describe" to "refine" so the textarea visibly signals the mode
        // has shifted from initial generation to iterative polish.
        return this.html
            ? t.modals.unifiedChat.placeholderPresentationRefine
            : t.modals.unifiedChat.placeholderPresentation;
    }


    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat;
        // Stash the i18n bundle so refreshAccessory has it available for
        // every state-change-driven re-render between renderContextPanel calls.
        this.accessoryT = t;
        // Register as the active instance for global commands (e.g. the
        // slide-picker command bound to Mod+Shift+S).
        PresentationModeHandler.activeInstance = this;

        // F3: dispose any prior SlideIframePreview BEFORE clearing the DOM.
        // Previously this was nested inside the `if (this.html)` recreate
        // branch — transitions to empty / error / non-preview states cleared
        // the container without ever calling dispose(), leaking the iframe
        // + its listeners.
        // F5: same for the navigate deferral — cancel before the container
        // goes away so it doesn't fire against a stale preview.
        this.clearNavigateTimeout();
        if (this.preview) {
            this.preview.dispose();
            this.preview = null;
        }
        // Drop the accessory ref before container.empty() so refreshAccessory
        // can't fire against detached DOM during the transition window.
        this.accessoryContainer = null;
        this.versionNavHost = null;
        // Tear down any prior CreatePanel subscription so resubscribing
        // below doesn't double-fire on controller events.
        if (this.createPanelDispose) {
            this.createPanelDispose();
            this.createPanelDispose = null;
        }

        container.empty();

        // Check brand availability
        this.brandAvailable = isBrandAvailable(ctx.app, ctx.plugin.settings);

        // Brand toggle — always shown, disabled with instructions if no file
        this.renderBrandToggle(container, ctx);

        // No deck yet — render the Create panel so the user can configure
        // sources / audience / length / speed before generating.
        if (!this.html) {
            this.ensureSourceController(ctx);
            const panelHost = container.createDiv({ cls: 'ai-organiser-pres-create-panel-host' });
            if (this.sourceController) {
                this.createPanelDispose = renderCreatePanel(panelHost, {
                    app: ctx.app,
                    plugin: ctx.fullPlugin,
                    controller: this.sourceController,
                    t,
                    getConfig: () => this.creationConfig,
                    onConfigChange: (next) => { this.creationConfig = next; },
                });
            }
        }

        if (this.phase === 'empty') return;

        // Slide preview
        if (this.html) {
            // Edit-flow accessory area — selection pill + mode pills + flags.
            // Sits above the iframe so the user sees the active scope before
            // they type the edit. Stable container reference enables in-place
            // re-render on state changes via refreshAccessory().
            this.accessoryContainer = container.createEl('div', {
                cls: 'ai-organiser-pres-accessory-host',
            });
            this.refreshAccessory();

            const previewContainer = container.createEl('div', { cls: 'ai-organiser-pres-preview-container' });
            this.preview = new SlideIframePreview(previewContainer, {
                onSlideSelect: (idx) => { this.activeSlideIndex = idx; },
                onElementSelect: (event) => { this.handleElementSelect(event); },
                emptyPlaceholderText: t.slidePreviewEmpty,
                bgHoverLabelTemplate: t.slideBgHoverTooltipTemplate,
            });
            // Project canonical HTML for the editor: adds data-element
            // attributes the iframe runtime walks on click. Canonical HTML
            // (no data-element) stays in this.html for prompts/exports.
            this.refreshPreview();
        }

        // Version navigation — rendered into a stable host so restoreVersion
        // can re-render the counter + button states in place.
        this.versionNavHost = container.createEl('div', { cls: 'ai-organiser-pres-version-host' });
        this.refreshVersionNav();

        // Phase status — F4: i18n-driven instead of hardcoded English literals.
        const phaseText = this.getPhaseStatusText(t);
        if (phaseText) {
            container.createEl('div', { cls: 'ai-organiser-pres-status', text: phaseText });
        }
        if (this.phase === 'error' && this.lastError) {
            const el = container.createEl('div', { cls: 'ai-organiser-pres-error' });
            el.textContent = this.lastError;
        }
    }

    /** F4: single source of truth for side-panel status text, maps phase
     *  → i18n key. Returns null for phases with no visible status line. */
    private getPhaseStatusText(t: Translations['modals']['unifiedChat']): string | null {
        switch (this.phase) {
            case 'generating': return t.phaseGenerating;
            case 'refining':   return t.phaseRefining;
            case 'auditing':   return t.phaseAuditing;
            case 'exporting':  return t.phaseExporting;
            default:           return null;
        }
    }

    /** F5: idempotent cancel for the navigate-to-slide deferral. Called from
     *  renderContextPanel (before rebuild) and dispose(). */
    private clearNavigateTimeout(): void {
        if (this.navigateTimeoutId !== null) {
            clearTimeout(this.navigateTimeoutId);
            this.navigateTimeoutId = null;
        }
    }

    /**
     * SINGLE, consistent preview refresh — called by EVERY deck mutation
     * (generate / refine / polish / scoped edit / version restore). Clamps the
     * active slide to the (possibly changed) deck size, projects the editor
     * HTML, restores the active slide, and re-applies the quality overlay. No
     * deck-mutation path should poke `this.preview.setHtml` directly — route
     * through here so the preview can never be left stale or blank.
     */
    private refreshPreview(): void {
        if (!this.preview || !this.html) return;
        const count = countSlides(this.html);
        if (this.activeSlideIndex < 0 || this.activeSlideIndex >= count) {
            this.activeSlideIndex = 0;
        }
        this.preview.setHtml(projectForEditor(this.html));
        if (this.activeSlideIndex > 0) {
            // F5: track the navigate handle so rapid re-render / dispose can
            // cancel the stale callback before it fires.
            this.clearNavigateTimeout();
            this.navigateTimeoutId = setTimeout(() => {
                this.navigateTimeoutId = null;
                this.preview?.navigateToSlide(this.activeSlideIndex);
            }, 200);
        }
        if (this.qualityResult) {
            this.preview.setQuality(this.qualityResult);
        }
    }

    /**
     * SINGLE, consistent post-mutation commit — every path that produces a new
     * deck (refine / whole-deck polish / selective polish) routes through here
     * so the preview, version timeline, reliability, quality state, and phase
     * never drift between paths. (Generation interleaves a brand audit but runs
     * the same steps inline.) Fixes the prior drift where polish skipped the
     * reliability + background quality scan.
     */
    private commitDeckMutation(opts: {
        deckIr: SlideDeckIr;
        html: string;
        versionLabel: string;
        llmCtx: LLMFacadeContext;
        signal: AbortSignal;
        resetActiveSlide?: boolean;
    }): void {
        if (opts.resetActiveSlide) this.activeSlideIndex = 0;
        this.deckIr = opts.deckIr;
        this.html = opts.html;
        this.refreshPreview();
        this.pushVersion(opts.versionLabel);
        this.updateReliability();
        this.runQualityCheck();
        this.clearSelection();
        this.setPhase('preview-ready');
        void this.runBackgroundQualityScan(opts.llmCtx, opts.signal);
    }

    buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        if (this.mutationLock) {
            return Promise.resolve({ prompt: '', directResponse: ctx.plugin.t.modals.unifiedChat.presentationBusy });
        }

        return Promise.resolve({
            prompt: '',
            streamingSetup: {
                start: async (streamCb) => {
                    this.cancelActiveOperation();
                    this.mutationLock = true;
                    const abort = new AbortController();
                    this.activeAbort = abort;
                    this.activeThinkingUpdater = (m) => streamCb.updateThinking?.(m);
                    // F4: stash translations for setPhase's lifetime so
                    // getPhaseMessage can localise without threading ctx
                    // through every internal helper.
                    this.activeT = ctx.plugin.t.modals.unifiedChat;

                    // Render Cancel button in the thinking indicator so the
                    // user always has an escape hatch during long generations.
                    streamCb.showCancelButton?.(() => this.cancelActiveOperation());

                    try {
                        const llmCtx = this.getLLMContext(ctx);
                        const theme = await this.getTheme(ctx);
                        const noteContent = this.truncateNoteContent(ctx);
                        const projectPrefix = this.buildProjectContextPrefix();
                        const effectiveQuery = projectPrefix ? `${projectPrefix}\n\n${query}` : query;

                        const runCtx: RunContext = {
                            ctx, streamCb, abort, llmCtx, theme,
                            effectiveQuery, history, originalQuery: query, noteContent,
                        };
                        if (!this.html) {
                            return await this.runGenerate(runCtx);
                        }
                        if (this.selection) {
                            return await this.runScopedEdit(runCtx, this.selection, this.editMode, this.editFlags);
                        }
                        return await this.runRefine(runCtx);
                    } finally {
                        this.mutationLock = false;
                        this.activeThinkingUpdater = null;
                        this.activeT = null;
                    }
                },
            },
        });
    }

    // ── Generation + refinement (extracted to keep buildPrompt lean) ─────────

    private async runGenerate(r: RunContext): Promise<StreamingResult> {
        this.setPhase('generating');
        // Structured-IR is the only generation path: produce a typed deck IR,
        // render it to preview HTML deterministically, and keep the IR for a
        // faithful PPTX export. On failure we surface an explicit error (no
        // silent HTML fallback) so a deck is always IR-backed.
        return await this.generateIr(r);
    }

    /**
     * Structured-IR generation. Returns a `StreamingResult` — success (deck
     * rendered + previewed) or an explicit error message. Never throws, never
     * falls back to raw-HTML generation (the deck is always IR-backed).
     */
    private async generateIr(r: RunContext): Promise<StreamingResult> {
        const t = r.ctx.plugin.t.modals.unifiedChat;
        // Drive the same progress UI + teardown as the streaming path so the
        // long single IR call shows live elapsed feedback (not a static spinner)
        // and the progress bar is cleared on completion.
        const controller = this.createProgressController(
            r.abort, r.streamCb, t, GENERATION_SOFT_BUDGET_MS, GENERATION_HARD_BUDGET_MS, undefined,
        );
        this.renderProgress(r.streamCb, t, 0, undefined, 0);
        const elapsedTimer = this.startElapsedTicker(controller, r.streamCb, t, undefined);
        try {
            const exportTheme = await this.resolveExportTheme(r.ctx);
            // Resolve attached sources (notes / web-search / folders) — this is
            // what actually runs the web search — and thread them into the IR
            // prompt so all create-panel inputs reach generation.
            let sources: PromptSource[] = [];
            if (this.sourceController) {
                // Model-aware budget so substantial sources (a full meeting note
                // + a full web result) reach generation untruncated on cloud
                // models, instead of the old flat 40K-char cap.
                const s = r.ctx.fullPlugin.settings;
                const provider = s.serviceType === 'local' ? 'local' : s.cloudServiceType;
                const totalBudgetChars = computeSourceBudgetChars(provider, s.cloudModel);
                const resolved = await this.sourceController.resolveForSubmit({
                    signal: r.abort.signal,
                    totalBudgetChars,
                });
                if (resolved.ok) sources = resolved.value.usable;
            }
            const irResult = await generateDeckIr(r.llmCtx, {
                userQuery: r.effectiveQuery,
                noteContent: r.noteContent,
                conversationHistory: r.history,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                targetLength: this.creationConfig.length,
                audience: this.creationConfig.audience,
                sources,
                signal: r.abort.signal,
            });
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!irResult.ok) {
                logger.error('Presentation', `[IR-gen] generation failed: ${irResult.error}`);
                this.setPhase('error');
                this.lastError = irResult.error;
                return { finalContent: t.slideGenerateFailed.replace('{error}', irResult.error) };
            }

            const built = buildHtmlFromDeckIr(
                irResult.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage,
                r.ctx.plugin.t.progress.presentation.slideRenderFailed,
            );
            if (!built.ok) {
                logger.error('Presentation', `[IR-gen] IR→HTML render failed: ${built.error}`);
                this.setPhase('error');
                this.lastError = built.error;
                return { finalContent: t.slideGenerateFailed.replace('{error}', built.error) };
            }

            this.deckIr = irResult.value;
            this.html = built.value;
            this.activeSlideIndex = 0;
            this.refreshPreview();
            this.pushVersion(r.originalQuery);
            this.updateReliability();

            if (this.brandEnabled && r.theme.auditChecklist.length > 0) {
                this.setPhase('auditing');
                await this.runAudit(r.llmCtx, r.theme, r.abort.signal);
            }

            this.runQualityCheck();
            this.setPhase('preview-ready');
            void this.runBackgroundQualityScan(r.llmCtx, r.abort.signal);

            const title = extractDeckTitle(built.value);
            const count = countSlides(built.value);
            return { finalContent: `Created "${title}" with ${count} slides. Describe changes to refine, or export when ready.` };
        } catch (e) {
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Presentation', `[IR-gen] threw: ${msg}`);
            this.setPhase('error');
            this.lastError = msg;
            return { finalContent: t.slideGenerateFailed.replace('{error}', msg) };
        } finally {
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }

    /** Resolve the user's ExportTheme (shared by IR→HTML preview + IR→PPTX). */
    /** Resolve the user's ExportTheme, memoised by a signature of the relevant
     *  export settings so repeated mutations don't re-import + re-resolve every
     *  call (Stage 3.1 cleanup). Recomputes when an export setting changes. */
    private exportThemeCache: { sig: string; theme: ExportTheme } | null = null;
    private async resolveExportTheme(ctx: ModalContext): Promise<ExportTheme> {
        const s = ctx.fullPlugin.settings;
        const sig = [
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor,
            s.exportFontFace, String(s.exportFontSize),
        ].join('|');
        if (this.exportThemeCache?.sig === sig) return this.exportThemeCache.theme;
        const { resolveTheme: resolveExportTheme } = await import('../../services/export/exportTheme');
        const theme = resolveExportTheme(
            s.exportColorScheme, s.exportPrimaryColor, s.exportAccentColor, s.exportFontFace, s.exportFontSize,
        );
        this.exportThemeCache = { sig, theme };
        return theme;
    }

    /** Polish an IR-backed deck by refining the IR (keeps it canonical). */
    private async polishDeckIr(
        ctx: ModalContext,
        llmCtx: LLMFacadeContext,
        theme: BrandTheme,
        abort: AbortController,
    ): Promise<void> {
        if (!this.deckIr) return;
        this.runQualityCheck();
        const findings = this.qualityResult?.findings ?? [];
        const polishRequest = findings.length > 0
            ? `Polish the deck. Improve clarity and fix these issues:\n${findings
                .map(f => `[${f.severity}] ${f.slideIndex !== undefined ? `Slide ${f.slideIndex + 1}: ` : ''}${f.issue} → ${f.suggestion}`)
                .join('\n')}`
            : 'Polish the deck: tighten wording, sharpen the visual hierarchy, and ensure one idea per slide. Keep the facts and the slide count unchanged.';
        const exportTheme = await this.resolveExportTheme(ctx);
        const refined = await refineDeckIr(llmCtx, {
            currentDeck: this.deckIr,
            userRequest: polishRequest,
            outputLanguage: ctx.plugin.settings.summaryLanguage,
            signal: abort.signal,
        });
        if (abort.signal.aborted || !refined.ok) return;
        const built = buildHtmlFromDeckIr(refined.value, exportTheme, theme.css, ctx.plugin.settings.summaryLanguage, ctx.plugin.t.progress.presentation.slideRenderFailed);
        if (!built.ok) return;
        this.commitDeckMutation({
            deckIr: refined.value,
            html: built.value,
            versionLabel: ctx.plugin.t.modals.polishSelector.versionLabelAll,
            llmCtx,
            signal: abort.signal,
        });
    }

    /**
     * IR refine for subsequent rounds — edits the deck IR so it stays the
     * canonical artifact (and export stays faithful). Returns a definitive
     * `StreamingResult` (success or explicit error); never falls back to a
     * raw-HTML refine. Never throws.
     */
    private async refineIr(r: RunContext): Promise<StreamingResult> {
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.deckIr) return { finalContent: t.slideRefineNoDeck };
        const controller = this.createProgressController(
            r.abort, r.streamCb, t, REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS, undefined,
        );
        this.renderProgress(r.streamCb, t, 0, undefined, 0);
        const elapsedTimer = this.startElapsedTicker(controller, r.streamCb, t, undefined);
        try {
            const exportTheme = await this.resolveExportTheme(r.ctx);
            const refined = await refineDeckIr(r.llmCtx, {
                currentDeck: this.deckIr,
                userRequest: r.effectiveQuery,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                signal: r.abort.signal,
            });
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!refined.ok) {
                logger.error('Presentation', `[IR-refine] failed: ${refined.error}`);
                this.setPhase('error');
                this.lastError = refined.error;
                return { finalContent: t.slideRefineFailed.replace('{error}', refined.error) };
            }
            const built = buildHtmlFromDeckIr(refined.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage, r.ctx.plugin.t.progress.presentation.slideRenderFailed);
            if (!built.ok) {
                logger.error('Presentation', `[IR-refine] IR→HTML failed: ${built.error}`);
                this.setPhase('error');
                this.lastError = built.error;
                return { finalContent: t.slideRefineFailed.replace('{error}', built.error) };
            }
            this.commitDeckMutation({
                deckIr: refined.value,
                html: built.value,
                versionLabel: r.originalQuery,
                llmCtx: r.llmCtx,
                signal: r.abort.signal,
            });
            const count = countSlides(built.value);
            return { finalContent: t.slideRefineApplied.replace('{n}', String(count)) };
        } catch (e) {
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Presentation', `[IR-refine] threw: ${msg}`);
            this.setPhase('error');
            this.lastError = msg;
            return { finalContent: t.slideRefineFailed.replace('{error}', msg) };
        } finally {
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }

    private async runRefine(r: RunContext): Promise<StreamingResult> {
        this.setPhase('refining');
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.html || !this.deckIr) return { finalContent: t.slideRefineNoDeck };
        // IR is the only refine path — edits the deck IR so it stays canonical
        // and the PPTX export stays faithful. Explicit error on failure (no
        // silent HTML-refine fallback).
        return await this.refineIr(r);
    }

    /** Scoped (targeted) edit path — invoked when the user has clicked an
     *  element/slide in the iframe and submitted an edit instruction. Routes to
     *  the IR slice-refine (`refineDeckIrSelective`) on the selected slide(s);
     *  the deck stays IR-backed. (Legacy HTML scoped editing — refineHtmlScoped
     *  + SlideDiffModal accept/reject + web-search context — was retired with
     *  the HTML engine; undo is via the version timeline.)
     */
    private async runScopedEdit(
        r: RunContext,
        scope: SelectionScope,
        mode: EditMode,
        _flags: EditFlags,
    ): Promise<StreamingResult> {
        this.setPhase('refining');
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.html || !this.deckIr) return { finalContent: t.slideEditNoDeck };

        // Targeted edit is now an IR slice-refine on the selected slide(s) —
        // IR-native (the deck stays canonical) and consistent with per-slide
        // Polish. Element-level precision degrades to slide-level; undo via the
        // version timeline. (Web-search-in-scoped-edit + DOM drift detection
        // were HTML-path features dropped with the legacy engine.)
        const start = scope.slideIndex;
        const end = scope.kind === 'range' && scope.slideEndIndex !== undefined ? scope.slideEndIndex : start;
        const indices: number[] = [];
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            if (i >= 0 && i < this.deckIr.slides.length) indices.push(i);
        }
        if (indices.length === 0) return { finalContent: t.slideEditNoDeck };

        const elementHint = scope.kind === 'element' && scope.elementKind
            ? ` Focus the change on the ${scope.elementKind} element.` : '';
        const modeHint = mode === 'design'
            ? ' Change only the visual design / layout, not the wording.' : '';
        const instruction = `${r.effectiveQuery}${elementHint}${modeHint}`.trim();

        const controller = this.createProgressController(
            r.abort, r.streamCb, t, REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS, undefined,
        );
        this.renderProgress(r.streamCb, t, 0, undefined, 0);
        const elapsedTimer = this.startElapsedTicker(controller, r.streamCb, t, undefined);
        try {
            const refined = await refineDeckIrSelective(r.llmCtx, {
                currentDeck: this.deckIr,
                selections: indices.map(slideIndex => ({ slideIndex, instruction })),
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                signal: r.abort.signal,
            });
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!refined.ok) {
                logger.error('Presentation', `[IR-scoped-edit] failed: ${refined.error}`);
                this.setPhase('error');
                this.lastError = refined.error;
                return { finalContent: t.slideEditFailed.replace('{error}', refined.error) };
            }
            const exportTheme = await this.resolveExportTheme(r.ctx);
            const built = buildHtmlFromDeckIr(refined.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage, r.ctx.plugin.t.progress.presentation.slideRenderFailed);
            if (!built.ok) {
                this.setPhase('error');
                this.lastError = built.error;
                return { finalContent: t.slideEditFailed.replace('{error}', built.error) };
            }
            this.commitDeckMutation({
                deckIr: refined.value,
                html: built.value,
                versionLabel: r.originalQuery,
                llmCtx: r.llmCtx,
                signal: r.abort.signal,
            });
            const count = countSlides(built.value);
            return { finalContent: t.slideEditApplied.replace('{n}', String(count)).replace('{drift}', '') };
        } catch (e) {
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Presentation', `[IR-scoped-edit] threw: ${msg}`);
            this.setPhase('error');
            this.lastError = msg;
            return { finalContent: t.slideEditFailed.replace('{error}', msg) };
        } finally {
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }


    /** Build a LongRunningOpController wired to the modal's streaming
     *  callbacks. Soft budget triggers the extend card; hard budget triggers
     *  abort + system notice. */
    private createProgressController(
        abort: AbortController,
        streamCb: StreamingCallbacks,
        t: Translations['modals']['unifiedChat'],
        softMs: number,
        hardMs: number,
        expected: number | undefined,
    ): LongRunningOpController {
        return new LongRunningOpController({
            softBudgetMs: softMs,
            hardBudgetMs: hardMs,
            expected,
            abortController: abort,
            onProgress: (current, exp, elapsedMs) => {
                this.renderProgress(streamCb, t, current, exp, elapsedMs);
            },
            onSoftBudget: (elapsedMs) => {
                // One-shot soft prompt. If the modal doesn't implement
                // requestBudgetExtension (optional hook), we treat it as
                // "user didn't cancel" and let generation run to the hard
                // cap — defensive per plan §6.
                if (!streamCb.requestBudgetExtension) return;
                void this.promptExtend(streamCb, t, abort, elapsedMs, softMs, hardMs);
            },
            onHardBudget: () => {
                const budgetMinutes = Math.round(hardMs / 60_000);
                streamCb.addSystemNotice(
                    t.generationHardCapped.replace('{budgetMinutes}', String(budgetMinutes)),
                );
            },
            onDispose: () => {
                // Forward dispose to the modal's cancel hook so the extend
                // card auto-dismisses. Idempotent: handle is cleared after use.
                if (this.pendingCancelHook) {
                    const hook = this.pendingCancelHook;
                    this.pendingCancelHook = null;
                    try { hook(); } catch { /* noop */ }
                }
            },
        });
    }

    /** Awaits the modal's extend-card and wires the result back to the
     *  abort controller. Extracted so `onSoftBudget` stays sync-looking. */
    private async promptExtend(
        streamCb: StreamingCallbacks,
        t: Translations['modals']['unifiedChat'],
        abort: AbortController,
        elapsedMs: number,
        softBudgetMs: number,
        hardBudgetMs: number,
    ): Promise<void> {
        if (!streamCb.requestBudgetExtension) return;
        const choice = await streamCb.requestBudgetExtension({
            elapsedMs,
            softBudgetMs,
            hardBudgetMs,
            // Modal registers a cancel fn; we stash so the controller's
            // dispose() (completion / hard cap) can force-dismiss the card.
            onRegisterCancelHook: (fn) => { this.pendingCancelHook = fn; },
        });
        if (choice === 'cancel') {
            abort.abort();
            streamCb.addSystemNotice(t.generationCancelled);
        }
    }

    /** Write the split DOM progress (live-region slide count + aria-hidden
     *  elapsed). Caches the current slide fragment so the 1s elapsed ticker
     *  can update elapsed without clobbering the slide text. */
    private renderProgress(
        streamCb: StreamingCallbacks,
        t: Translations['modals']['unifiedChat'],
        current: number,
        expected: number | undefined,
        elapsedMs: number,
    ): void {
        const slideFrag = this.formatSlideFragment(t, current, expected);
        const elapsedFrag = t.presentationElapsedSeconds
            .replace('{elapsed}', String(Math.floor(elapsedMs / 1000)));
        this.lastSlideFragment = slideFrag;

        if (streamCb.updateProgressSplit) {
            streamCb.updateProgressSplit(slideFrag, elapsedFrag);
        } else {
            // Fallback: combine for modals that only implement updateThinking.
            streamCb.updateThinking?.(`${slideFrag} ${elapsedFrag}`);
        }
    }

    private formatSlideFragment(
        t: Translations['modals']['unifiedChat'],
        current: number,
        expected: number | undefined,
    ): string {
        if (current === 0) return t.presentationStarting;
        if (expected !== undefined) {
            return t.presentationProgress
                .replace('{current}', String(current))
                .replace('{expected}', String(expected));
        }
        return t.presentationProgressNoTotal.replace('{current}', String(current));
    }

    /** 1s interval that re-renders progress with the cached slide fragment +
     *  updated elapsed. Returns the interval id for cleanup. */
    private startElapsedTicker(
        controller: LongRunningOpController,
        streamCb: StreamingCallbacks,
        t: Translations['modals']['unifiedChat'],
        expected: number | undefined,
    ): ReturnType<typeof setInterval> {
        return globalThis.setInterval(() => {
            const current = controller.getLastProgress();
            this.renderProgress(streamCb, t, current, expected, controller.getElapsedMs());
        }, 1000);
    }

    getActionDescriptors(_t: Translations): ActionDescriptor[] {
        const hasDeck = !!this.html;
        const ready = this.phase === 'preview-ready';
        const locked = this.mutationLock;

        // Export HTML is the primary CTA: the HTML note is the editable
        // intermediate form users iterate on via chat. PPTX is a terminal
        // export for when they're finished refining. (User feedback 2026-04-20.)
        // Presentation actions operate on the deck (export to file / refine /
        // discard) — none require an open markdown editor, so requiresEditor is
        // false (otherwise the modal disables them when no note is focused).
        const actions: ActionDescriptor[] = [
            {
                id: 'export-html',
                labelKey: 'Save as HTML note',
                tooltipKey: 'Save as a self-contained HTML note — keep chatting to refine, then export when finished',
                isEnabled: hasDeck && ready && !locked,
                requiresEditor: false,
                isDefault: true,
            },
            {
                id: 'export-pptx',
                labelKey: 'Export to PPTX',
                tooltipKey: 'Final export to editable PowerPoint file',
                isEnabled: hasDeck && ready && !locked,
                requiresEditor: false,
            },
        ];

        // Brand audit button only if brand is enabled
        if (this.brandEnabled && this.brandAvailable) {
            actions.push({
                id: 'check-brand',
                labelKey: 'Check Brand',
                tooltipKey: 'Run brand compliance audit and fix violations',
                isEnabled: hasDeck && ready && !locked,
                requiresEditor: false,
            });
        }

        actions.push(
            {
                id: 'polish',
                labelKey: 'Polish',
                tooltipKey: 'Run quality checks and refine',
                isEnabled: hasDeck && ready && !locked,
                requiresEditor: false,
            },
            {
                id: 'discard',
                labelKey: 'Discard',
                tooltipKey: 'Discard current presentation',
                isEnabled: hasDeck && !locked,
                requiresEditor: false,
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
        this.clearNavigateTimeout();  // F5
        this.html = null;
        this.deckIr = null;
        this.versions = [];
        this.versionIndex = -1;
        this.activeSlideIndex = 0;
        this.qualityResult = null;
        this.lastError = null;
        this.phase = 'empty';
        // Scoped-editing state — clear selection and reset mode/flags so a
        // fresh deck doesn't inherit stale scope from the previous one.
        this.selection = null;
        this.editMode = 'content';
        this.editFlags = { webSearch: false, references: [] };
        // Increment epoch + reset source controller so the next creation
        // cycle starts clean and conversation history from the prior cycle
        // can be filtered out of generation prompts (audit Gemini-r2-G3 +
        // r5-G3 + r6-G1).
        this.creationFlowEpoch++;
        if (this.sourceController) this.sourceController.reset();
        this.creationConfig = { ...DEFAULT_CREATION_CONFIG };
    }

    dispose(): void {
        this.cancelActiveOperation();
        this.clearNavigateTimeout();  // F5
        this.preview?.dispose();
        this.preview = null;
        this.accessoryContainer = null;
        this.versionNavHost = null;
        this.accessoryT = null;
        this.selection = null;
        if (this.createPanelDispose) {
            this.createPanelDispose();
            this.createPanelDispose = null;
        }
        if (this.sourceController) {
            this.sourceController.dispose();
            this.sourceController = null;
        }
        this.creationFlowEpoch++;
        if (PresentationModeHandler.activeInstance === this) {
            PresentationModeHandler.activeInstance = null;
        }
    }

    /** Public seam for the global slide-picker command (Mod+Shift+S).
     *  Returns true if the picker was opened, false if no deck is loaded. */
    hasDeck(): boolean {
        return this.html !== null;
    }

    /**
     * Layout state for the side-rail workspace controller (plan: slides-side-rail).
     * `hasDeck` gates the grid (stays true through transient loading/error phases
     * so the layout doesn't flicker); `deckVersion` bumps on every committed
     * mutation (generate/refine/polish/restore push a version) so the controller
     * can resync deterministically.
     */
    getLayoutState(): { hasDeck: boolean; deckVersion: number } {
        return {
            hasDeck: this.html !== null && this.phase !== 'empty',
            deckVersion: this.versions.length,
        };
    }

    /** Used by the slide-picker command to read deck HTML. */
    getDeckHtml(): string | null {
        return this.html;
    }

    /** Set selection from outside (slide-picker command). Mirrors the
     *  iframe-click path so the chat-input accessory updates correctly. */
    selectSlideFromCommand(slideIndex: number): void {
        if (!this.html) return;
        this.selection = { kind: 'slide', slideIndex };
        this.activeSlideIndex = slideIndex;
        this.refreshAccessory();
    }

    /** Lazy controller construction — runs on first renderContextPanel so
     *  we have `ctx.app`. Idempotent. */
    private ensureSourceController(ctx: ModalContext): void {
        if (this.sourceController) return;
        const research = new ResearchSearchService(ctx.fullPlugin);
        // Adapter: ResearchSearchService takes string[] queries and returns
        // SearchResult[]. The source service only needs a string-returning
        // `search`. Wrap with a thin adapter that concatenates results.
        const dispatcher = {
            search: async (query: string, _opts?: { signal?: AbortSignal }): Promise<string> => {
                const results = await research.search([query]);
                return results
                    .map(r => `# ${r.title}\n${r.url}\n${r.extractedContent ?? r.snippet ?? ''}`)
                    .join('\n\n');
            },
        };
        const service = new PresentationSourceService(ctx.app, dispatcher);
        this.sourceController = new CreationSourceController(ctx.app, service);
        // Auto-detect active note as the first source.
        const auto = service.detectActiveNote();
        if (auto) {
            this.sourceController.addSource(auto);
            void this.sourceController.preloadAsync(0);
        }
    }

    // ── Selection state (slide-authoring-editing plan) ──────────────────────

    /** Iframe element-click handler. Updates selection and re-renders the
     *  chat-input accessory area so the user sees the new scope pill. */
    private handleElementSelect(event: import('../components/SlideIframePreview').IframeSelectionEvent): void {
        if (this.mutationLock) return; // ignore clicks during apply
        if (event.kind === 'slide') {
            this.selection = { kind: 'slide', slideIndex: event.slideIndex };
        } else {
            // Coerce the runtime-derived `elementKind` string to the typed
            // ElementKind union; unknown kinds drop through as undefined so
            // the prompt builder treats them as generic elements.
            const knownKinds: ReadonlySet<string> = new Set([
                'heading', 'subheading', 'list', 'list-item',
                'image', 'figure', 'table', 'callout',
                'col-container', 'col', 'stats-grid',
                'quote', 'code', 'speaker-notes',
            ]);
            const elementKind = knownKinds.has(event.elementKind)
                ? (event.elementKind as import('../../services/chat/presentationTypes').ElementKind)
                : undefined;
            this.selection = {
                kind: 'element',
                slideIndex: event.slideIndex,
                elementPath: event.elementPath,
                elementKind,
            };
        }
        this.activeSlideIndex = event.slideIndex;
        this.refreshAccessory();
    }

    /** Test seam — exposed for unit tests that need to drive the handler
     *  without going through the iframe's postMessage path. */
    setSelectionForTesting(scope: SelectionScope | null): void {
        this.selection = scope;
    }

    /** Test seam — read the current selection without mutating. */
    getSelection(): SelectionScope | null {
        return this.selection;
    }

    /** Clear the active selection — called by the × button on the selection
     *  pill, by Esc keypress, and on every successful apply (so the next
     *  edit doesn't inadvertently target stale scope). */
    private clearSelection(): void {
        this.selection = null;
        this.refreshAccessory();
    }

    /** Set edit mode (Content vs Design). Hidden when no selection set. */
    private setEditMode(mode: EditMode): void {
        this.editMode = mode;
        this.refreshAccessory();
    }

    /** Toggle the web-search flag (Content mode only). */
    private setWebSearchFlag(on: boolean): void {
        this.editFlags = { ...this.editFlags, webSearch: on };
        this.refreshAccessory();
    }

    /** Idempotent re-render of the accessory area when state changes.
     *  Reads `accessoryT` which is set by renderContextPanel — this stays
     *  populated for the panel's lifetime, unlike `activeT` which is only
     *  alive during buildPrompt's start hook.
     *
     *  Uses a static import (not dynamic) — the persona walkthrough
     *  identified the dynamic-import path as the source of first-click
     *  selection lag. The accessory module is small and used every Edit
     *  flow render; no benefit to lazy loading.
     */
    private refreshAccessory(): void {
        if (!this.accessoryContainer || !this.accessoryT) return;
        renderEditAccessories(this.accessoryContainer, {
            selection: this.selection,
            editMode: this.editMode,
            editFlags: this.editFlags,
            operation: this.deriveOperation(),
            t: this.accessoryT,
            onClearSelection: () => this.clearSelection(),
            onSetMode: (m) => this.setEditMode(m),
            onSetWebSearch: (on) => this.setWebSearchFlag(on),
        });
    }

    /** Map the existing PresentationPhase to the two-axis (deckPresence,
     *  operation) view from the plan. Used by the accessory renderer to
     *  decide whether pills are interactive or disabled-with-spinner. */
    private deriveOperation(): 'idle' | 'applying' | 'error' {
        switch (this.phase) {
            case 'generating':
            case 'refining':
            case 'auditing':
            case 'exporting':
                return 'applying';
            case 'error':
                return 'error';
            default:
                return 'idle';
        }
    }

    // ── Project context ─────────────────────────────────────────────────────

    setProjectContext(config: ProjectConfig | null): void {
        this.projectInstructions = config?.instructions ?? null;
        this.projectMemory = config?.memory ?? [];
    }

    clearProjectContext(): void {
        this.projectInstructions = null;
        this.projectMemory = [];
    }

    private buildProjectContextPrefix(): string {
        const parts: string[] = [];
        if (this.projectInstructions) parts.push(`Project instructions: ${this.projectInstructions}`);
        if (this.projectMemory.length > 0) parts.push(`Project context: ${this.projectMemory.join('; ')}`);
        return parts.join('\n\n');
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
            // Persist the deck IR so a faithful native PPTX export + further
            // IR editing survive a reload.
            deckIr: this.deckIr ?? undefined,
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
        // Rehydrate the persisted deck IR (validated). New sessions always carry
        // it; a legacy session saved before structured editing loads view-only
        // (deckIr null → IR refine/polish guard out gracefully, and PPTX export
        // falls through to the dom-to-pptx path on the restored HTML).
        const rawIr = (data as { deckIr?: unknown } | null)?.deckIr;
        const validated = rawIr != null ? validateDeckIr(rawIr) : null;
        this.deckIr = validated?.ok ? validated.value : null;
        this.versions = session.versions.slice(0, MAX_VERSIONS);
        this.versionIndex = this.versions.length - 1;
        this.brandEnabled = session.brandEnabled;
        this.activeSlideIndex = 0;
        this.phase = 'preview-ready';
        return true;
    }

    // ── Export: PPTX via dom-to-pptx ────────────────────────────────────────

    private async exportPptx(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        // Phase 1B F8: replace silent returns with user-visible notices so
        // broken-state clicks don't look like the button is dead.
        if (!this.html) {
            callbacks.notify('Can\'t export — no presentation generated yet.');
            return;
        }
        if (this.mutationLock) {
            callbacks.notify('Can\'t export right now — generation / refinement in progress.');
            return;
        }
        if (!this.preview) {
            callbacks.notify('Preview not ready — click into the slide panel once, then retry export.');
            return;
        }
        this.mutationLock = true;
        this.setPhase('exporting');
        callbacks.rerenderActions();

        try {
            const iframeDoc = this.preview.getIframeDocument();
            if (!iframeDoc) throw new Error('iframe not ready');

            // Show all slides for export (remove nav-hidden class)
            const allSlides = iframeDoc.querySelectorAll('.slide');
            allSlides.forEach(s => s.classList.remove('pres-nav-hidden'));

            const title = extractDeckTitle(this.html);
            const fileName = sanitizeFileName(title) + '.pptx';

            // Phase 2 sister-backport: prefer the rich renderer so exported
            // decks are editable in PowerPoint (real text boxes, tables,
            // notes) instead of rasterised slide screenshots.
            const richBuffer = await this.tryRichPptxExport(ctx, title);
            if (richBuffer) {
                this.downloadBuffer(richBuffer, fileName);
            } else {
                // Parser returned zero slides (unexpected HTML shape) — fall
                // back to the legacy DOM-to-pptx path which rasterises the
                // rendered iframe. Loses editability but ships a usable file.
                const { exportToPptx } = await import('dom-to-pptx');
                await exportToPptx(Array.from(allSlides) as HTMLElement[], { fileName });
            }

            // Restore single-slide view
            this.preview.navigateToSlide(this.activeSlideIndex);

            callbacks.notify('Exported to PPTX — check your downloads folder.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.notify(`PPTX export failed: ${msg}`);
            logger.error('Presentation', `PPTX export failed: ${msg}`);
        } finally {
            this.setPhase('preview-ready');
            this.mutationLock = false;
            callbacks.rerenderActions();
        }
    }

    /**
     * Attempt the Phase 2 rich PPTX path: parse the current HTML into
     * RichSlideJSON, render with pptxgenjs. Returns `null` when the parser
     * yields zero slides (so the caller can fall back to dom-to-pptx) or
     * when the user's theme resolution fails. Any render-time error is
     * rethrown so the outer try/catch surfaces it to the user.
     */
    private async tryRichPptxExport(
        ctx: ModalContext,
        _deckTitle: string,
    ): Promise<ArrayBuffer | null> {
        if (!this.html || !this.deckIr) return null;
        try {
            const exportTheme = await this.resolveExportTheme(ctx);
            // The deck is always IR-backed — render a faithful native PPTX from
            // the IR. On render failure return null so the caller falls back to
            // dom-to-pptx on the rendered HTML.
            const { renderDeckToPptx } = await import('../../services/presentationIr');
            const result = await renderDeckToPptx(this.deckIr, exportTheme, { placeholderLabel: ctx.plugin.t.progress.presentation.slideRenderFailed });
            if (result.ok) return result.value.buffer;
            logger.warn('Presentation', `IR PPTX render failed: ${result.error}`);
            return null;
        } catch (e) {
            logger.warn('Presentation', `Rich PPTX path failed, will fall back to dom-to-pptx: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    /** Browser download of an ArrayBuffer via a transient anchor click. */
    private downloadBuffer(buffer: ArrayBuffer, fileName: string): void {
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Defer revoke to the next macrotask so the click has landed.
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    // ── Export: HTML ─────────────────────────────────────────────────────────

    private async exportHtmlFile(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        // Phase 1B F8: same treatment as exportPptx — user-visible notices.
        if (!this.html) {
            callbacks.notify('Can\'t save — no presentation generated yet.');
            return;
        }
        if (this.mutationLock) {
            callbacks.notify('Can\'t save right now — generation / refinement in progress.');
            return;
        }
        this.mutationLock = true;
        this.setPhase('exporting');
        callbacks.rerenderActions();

        try {
            const title = extractDeckTitle(this.html);
            const folder = this.getOutputFolder(ctx);
            const fileName = sanitizeFileName(title) + '.html';
            const path = await getAvailablePath(ctx, folder, fileName);

            await ctx.app.vault.create(path, this.html);
            callbacks.notify(`Saved to ${path}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.notify(`HTML export failed: ${msg}`);
        } finally {
            this.setPhase('preview-ready');
            this.mutationLock = false;
            callbacks.rerenderActions();
        }
    }

    // ── Brand Audit ─────────────────────────────────────────────────────────

    private async handleBrandAudit(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || !this.brandEnabled || this.mutationLock) return;
        this.mutationLock = true;
        this.activeThinkingUpdater = (m) => callbacks.showThinking(m);
        this.activeT = ctx.plugin.t.modals.unifiedChat;  // F4
        this.setPhase('auditing');
        callbacks.rerenderActions();

        // Abort any prior in-flight operation before taking the slot — mutationLock
        // prevents concurrent entry today, but onClear()/dispose() call
        // cancelActiveOperation() on whatever's pointed to by activeAbort, so we
        // must not leave a stale controller behind.
        this.cancelActiveOperation();
        const abort = new AbortController();
        this.activeAbort = abort;

        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);

            const result = await runBrandAudit(llmCtx, this.html, theme, abort.signal);
            if (abort.signal.aborted) return;

            if (result.ok && result.value.violations.length > 0) {
                this.preview?.applyDomFixes(result.value.violations);
                callbacks.notify(
                    `Brand audit: ${result.value.violations.length} fix(es) applied.`
                );
            } else if (result.ok) {
                callbacks.notify('Brand audit: all checks passed.');
            }

            this.runQualityCheck(result.ok ? result.value.violations.length : 0);
            this.setPhase('preview-ready');
        } catch (e) {
            if (!abort.signal.aborted) {
                this.setPhase('error');
                this.lastError = e instanceof Error ? e.message : 'Audit failed';
            }
        } finally {
            this.mutationLock = false;
            this.activeThinkingUpdater = null;
            this.activeT = null;
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
        if (this.activePolish) return;                       // single-flight: modal already open
        if (!this.html || this.mutationLock) return;

        // Per-slide polish: a deck with >1 slide opens the selector modal so the
        // user can target specific slides; a single-slide deck polishes whole.
        if (this.deckIr !== null && this.deckIr.slides.length > 1) {
            // Run the autodetect quality scan first so the per-slide polish
            // boxes prefill with detected issues — the per-slide findings come
            // from the LLM fast scan, which may not have finished after
            // generation. Skip if we already have per-slide findings.
            if (!this.hasPerSlideFindings() && !this.mutationLock) {
                this.mutationLock = true;
                callbacks.showThinking(ctx.plugin.t.modals.polishSelector.analysingLabel);
                callbacks.rerenderActions();
                try {
                    await this.ensureQualityFindings(ctx);
                } finally {
                    this.mutationLock = false;
                    callbacks.hideThinking();
                    callbacks.rerenderActions();
                }
            }
            this.openPolishSelector(ctx, callbacks);
            return;
        }

        await this.runWholeDeckPolish(ctx, callbacks);
    }

    /** True when at least one finding is scoped to a specific slide — i.e. the
     *  LLM fast scan has produced the per-slide issues the polish boxes prefill
     *  from. */
    private hasPerSlideFindings(): boolean {
        return (this.qualityResult?.findings ?? []).some(f => f.slideIndex !== undefined);
    }

    /** Run the autodetect quality scan (structural pass → LLM fast scan) so
     *  `this.qualityResult.findings` carries per-slide issues before the polish
     *  modal opens. Best-effort: the modal still opens if the scan fails. */
    private async ensureQualityFindings(ctx: ModalContext): Promise<void> {
        this.runQualityCheck();                       // structural — sets qualityResult
        const llmCtx = this.getLLMContext(ctx);
        const abort = new AbortController();
        try {
            await this.runBackgroundQualityScan(llmCtx, abort.signal);  // LLM fast scan → per-slide findings
        } catch (e) {
            logger.warn('Presentation', `Polish pre-scan failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Whole-deck polish (single-slide IR or legacy HTML). Unchanged behaviour
     *  extracted from the original handlePolish (plan §4.6: all-slides path
     *  stays untouched). */
    private async runWholeDeckPolish(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.html || this.mutationLock) return;
        this.mutationLock = true;
        this.activeThinkingUpdater = (m) => callbacks.showThinking(m);
        this.activeT = ctx.plugin.t.modals.unifiedChat;  // F4
        this.setPhase('refining');
        callbacks.rerenderActions();

        // Same rationale as handleBrandAudit — abort any stale controller so
        // onClear()/dispose() never hold a reference to a defunct one.
        this.cancelActiveOperation();
        const abort = new AbortController();
        this.activeAbort = abort;

        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);

            // The deck is always IR-backed — polish via the IR (keeps export
            // faithful). polishDeckIr runs the autodetect scan + general/issue
            // refine and routes through commitDeckMutation.
            if (this.deckIr) {
                await this.polishDeckIr(ctx, llmCtx, theme, abort);
            }

            if (this.brandEnabled && theme.auditChecklist.length > 0 && !abort.signal.aborted) {
                this.setPhase('auditing');
                await this.runAudit(llmCtx, theme, abort.signal);
            }

            this.runQualityCheck();
            // Whole-deck mutation invalidates positional selection paths.
            // Plan §"State transitions" mandates clearing on every html mutation.
            this.clearSelection();
            this.setPhase('preview-ready');
            callbacks.notify(
                `Polish complete. Quality: ${this.qualityResult?.totalScore ?? '?'}/100`
            );
        } catch (e) {
            if (!abort.signal.aborted) {
                this.setPhase('error');
                this.lastError = e instanceof Error ? e.message : 'Polish failed';
                callbacks.notify(`Polish failed: ${this.lastError}`);
            }
        } finally {
            this.mutationLock = false;
            this.activeThinkingUpdater = null;
            this.activeT = null;
            callbacks.hideThinking();
            callbacks.rerenderActions();
        }
    }

    /** Open the per-slide polish selector for a multi-slide IR deck. The modal
     *  owns its own submitting/error UI; the handler only mutates deck state
     *  after a Result.ok from `runPolishSubmit` (plan §4.2b). */
    private openPolishSelector(ctx: ModalContext, callbacks: ActionCallbacks): void {
        const llmCtx = this.getLLMContext(ctx);
        const deck = this.deckIr!;
        // Local view of findings — NO mutation of this.qualityResult here
        // (audit-r2 H1 + r3 H5). A null scan simply yields empty placeholders.
        const findings = this.qualityResult?.findings ?? [];
        const tSlice = ctx.plugin.t.modals.polishSelector;

        const modal = new PolishSelectorModal(
            ctx.app,
            deck,
            findings,
            tSlice,
            {
                onSubmit: (draft, signal) => this.runPolishSubmit(ctx, llmCtx, draft, signal),
                onClose: () => {
                    if (this.activePolish?.modal === modal) this.activePolish = null;
                    callbacks.rerenderActions();
                },
            },
        );
        this.activePolish = { modal };
        try {
            modal.open();
        } catch (e) {
            // Never leave the single-flight guard stuck if open() throws —
            // otherwise every later Polish click silently no-ops.
            this.activePolish = null;
            logger.error('Presentation', `Polish modal failed to open: ${e instanceof Error ? e.message : String(e)}`);
            new Notice('Could not open the polish dialog — please try again.');
        }
    }

    /** Run one polish submission from the selector modal. Returns a Result-like
     *  outcome the modal uses to decide close (ok) vs error-banner (err).
     *  Mutates handler state only on success (plan §2.2 invariant). */
    private async runPolishSubmit(
        ctx: ModalContext,
        llmCtx: LLMFacadeContext,
        draft: PolishSubmit,
        signal: AbortSignal,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const tSlice = ctx.plugin.t.modals.polishSelector;
        const theme = await this.getTheme(ctx);

        // "All slides" → existing whole-deck IR polish, unchanged. Bridge the
        // modal's AbortSignal to the AbortController polishDeckIr expects so
        // abort semantics stay consistent across both paths (audit-r3 H4).
        if (draft.kind === 'all') {
            const localAbort = new AbortController();
            const onAbort = () => localAbort.abort();
            if (signal.aborted) localAbort.abort();
            else signal.addEventListener('abort', onAbort);
            try {
                await this.polishDeckIr(ctx, llmCtx, theme, localAbort);
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
            return { ok: true };
        }

        // Selective path — wrapped in withProgressResult so the reporter owns
        // the toast (audit-r2 M1). Compute phase (refine + build HTML) runs
        // inside; commit phase runs after Result.ok and cannot fail.
        const deckWideFindings = (this.qualityResult?.findings ?? []).filter(f => f.slideIndex === undefined);
        const compute = await withProgressResult<{ refined: SlideDeckIr; html: string }, 'polishing'>(
            {
                plugin: ctx.fullPlugin,
                initialPhase: { key: 'polishing' },
                resolvePhase: () => tSlice.progressLabel,
            },
            async () => {
                const refined = await refineDeckIrSelective(llmCtx, {
                    currentDeck: this.deckIr!,
                    selections: draft.selections,
                    deckWideFindings,
                    outputLanguage: ctx.plugin.settings.summaryLanguage,
                    signal,
                });
                if (!refined.ok) {
                    const code = parseRefineErrorCode(refined.error) ?? 'unexpected-exception';
                    // Map abort → cancel sentinel so the reporter shows a
                    // neutral "Cancelled", not a red "Failed".
                    if (code === 'aborted') return err('cancelled');
                    return err(tSlice.errorByCode[code] ?? tSlice.errorByCode['unexpected-exception']);
                }
                const exportTheme = await this.resolveExportTheme(ctx);
                const built = buildHtmlFromDeckIr(refined.value, exportTheme, theme.css, ctx.plugin.settings.summaryLanguage, ctx.plugin.t.progress.presentation.slideRenderFailed);
                if (!built.ok) return err(tSlice.errorByCode['invalid-deck-after-splice']);
                return ok({ refined: refined.value, html: built.value });
            },
        );

        if (!compute.ok) {
            return { ok: false, error: compute.error };
        }

        // ── Commit (Result.ok only) — routed through the SAME consolidated
        // post-mutation path as refine/polish, so quality is re-scanned fresh
        // (handles split-induced index shifts) rather than hand-filtered.
        const { refined, html } = compute.value;
        // Version-history label with 1-based UI slide numbers (audit-r2 M2).
        const slideNumbers = [...draft.selections.map(s => s.slideIndex)]
            .sort((a, b) => a - b)
            .map(i => i + 1)
            .join(', ');
        const preview = (draft.selections[0]?.instruction ?? '').slice(0, 40).replace(/\s+/g, ' ').trim();
        const label = tSlice.versionLabel
            .replace('{slideNumbers}', slideNumbers)
            .replace('{preview}', preview);
        this.commitDeckMutation({ deckIr: refined, html, versionLabel: label, llmCtx, signal });

        return { ok: true };
    }

    private handleDiscard(callbacks: ActionCallbacks): void {
        this.onClear();
        callbacks.notify('Presentation discarded.');
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
            deckIr: this.deckIr ?? undefined,
        });
        if (this.versions.length > MAX_VERSIONS) this.versions.shift();
        this.versionIndex = this.versions.length - 1;
    }

    private restoreVersion(index: number): void {
        if (index < 0 || index >= this.versions.length) return;
        const version = this.versions[index];
        this.html = version.html;
        // Restore the version's IR snapshot so the deck stays IR-backed (and
        // editable/exportable). Versions captured post-IR always carry it.
        this.deckIr = version.deckIr ?? null;
        this.activeSlideIndex = version.activeSlideIndex;
        this.versionIndex = index;
        // Restoring a version is a whole-deck swap. Selection paths that
        // resolved against the previous version may not exist (or may
        // resolve to different content) in the restored one. Clear it.
        this.clearSelection();
        this.phase = 'preview-ready';
        // Consistency: a version swap is a deck mutation — refresh the preview
        // and the nav (counter + button states) like every other path.
        this.refreshPreview();
        this.refreshVersionNav();
    }

    /** Re-render the version nav in its stable host (counter + button states).
     *  Called on mount and after every restoreVersion so the UI tracks state. */
    private refreshVersionNav(): void {
        if (!this.versionNavHost) return;
        this.versionNavHost.empty();
        if (this.versions.length > 1) this.renderVersionNav(this.versionNavHost);
    }

    private renderVersionNav(container: HTMLElement): void {
        const nav = container.createEl('div', { cls: 'ai-organiser-pres-version-nav' });

        const prevBtn = nav.createEl('button', { cls: 'ai-organiser-pres-version-btn', text: '◄ prev' });
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
        return pluginContext(ctx.fullPlugin);
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
        // Same hazard for the per-slide polish modal — close it so its
        // in-flight LLM call aborts and onClose clears activePolish before
        // handler state is nulled (audit-r3 H4).
        if (this.activePolish) {
            this.activePolish.modal.close();
            this.activePolish = null;
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

    /** Phase 3: classify and display reliability from sanitizer results. */
    private updateReliability(): void {
        if (!this.html || !this.preview) return;
        const result = sanitizePresentation(this.html);
        const tier = classifyReliability({
            rejectionCount: result.rejectionCount,
            hasDeckRoot: result.hasDeckRoot,
            hasSlides: result.hasSlides,
        });
        this.preview.setReliability(tier);
    }

    private async runBackgroundQualityScan(ctx: LLMFacadeContext, signal: AbortSignal): Promise<void> {
        if (!this.html) return;
        const slideCount = countSlides(this.html);

        const fastResult = await runFastScan(ctx, this.html, slideCount, signal);
        if (signal.aborted || !fastResult.ok) return;

        // Merge with existing deterministic findings
        const merged = deduplicateFindings(
            this.qualityResult?.findings ?? [],
            fastResult.value.findings
        );
        if (this.qualityResult) {
            this.qualityResult = { ...this.qualityResult, findings: merged };
            this.preview?.setQuality(this.qualityResult);
        }
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
