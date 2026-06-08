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

import { Notice, TFile } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type {
    ChatModeHandler, ChatMode, ModalContext, SendResult,
    ActionDescriptor, ActionCallbacks,
    StreamingCallbacks, StreamingResult,
} from './ChatModeHandler';
import { pluginContext, summarizeText } from '../../services/llmFacade';
import type { LLMFacadeContext } from '../../services/llmFacade';
import {
    type PresentationPhase,
    type SelectionScope, type EditMode, type EditFlags,
    MAX_VERSIONS, extractSlideInfo, runStructureChecks, computeQualityScore,
    migratePresentationSession, classifyReliability,
} from '../../services/chat/presentationTypes';
import { runBrandAudit, generateDeckIr, refineDeckIr, buildHtmlFromDeckIr } from '../../services/chat/presentationHtmlService';
import type { SlideDeckIr } from '../../services/presentationIr/slideIr';
import { validateDeckIr } from '../../services/presentationIr/slideIr';
import type { Result } from '../../core/result';
import type { EvidenceSpan } from '../../services/presentationIr/consultantStoryboard';
import { buildEvidenceCatalog } from '../../services/presentationIr/evidenceCatalog';
import { runStoryboardStage, buildDeckFromStoryboard, buildDeckFromStoryline, reviseStoryboard, looksLikeBuildCommand } from '../../services/chat/consultantStoryboardPipeline';
import { classifyStorylineNote } from '../../services/chat/storylineNote';
import { markdownToStoryboard } from '../../services/presentationIr/dotDashParser';
import { resolvePresentationRole, type PresentationRole } from '../../services/presentationIr/presentationModelResolver';
import { buildStoryboardJudge } from '../../services/chat/consultantCriticService';
import type { StoryboardJudge } from '../../services/chat/consultantAuditService';
import { resolveProviderProfile } from '../../services/providerProfile';
import { CloudLLMService } from '../../services/cloudService';
import { PROVIDER_ENDPOINT } from '../../services/adapters/providerRegistry';
import type { AdapterType } from '../../services/adapters';
import { ResearchSearchService } from '../../services/research/researchSearchService';
import { PolishSelectorModal, type PolishSubmit } from '../modals/PolishSelectorModal';
import { refineDeckIrSelective, parseRefineErrorCode } from '../../services/chat/refineDeckIrSelective';
import { withProgressResult } from '../../services/progress';
import { ok, err } from '../../core/result';
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
import { extractDeckTitle, countSlides, buildWebSearchGroundingPrompt, GROUNDED_QUERY_MAX_CHARS } from '../../services/prompts/presentationChatPrompts';
import type { WebSearchGroundingFn } from '../../services/chat/presentationSourceService';
import { getMaxContentCharsForModel, truncateAtBoundary } from '../../services/tokenLimits';
import { logger } from '../../utils/logger';
import type { ProjectConfig } from '../../services/chat/projectService';
import { registerPresentationTarget, unregisterPresentationTarget } from './presentation/presentationCommandRegistry';
import { PresentationThemeResolver } from './presentation/presentationThemeResolver';
import { PresentationExporter } from './presentation/presentationExporter';
import { resolveBrandRenderContext, type ResolvedBrandAssets } from '../../services/export/brand/brandRenderContext';
import { collectDeckIconConcepts } from '../../services/presentationIr/deckIconConcepts';
import { EditScopeController } from './presentation/editScopeController';
import { PresentationDeckStore } from './presentation/presentationDeckStore';
import { PresentationCanvasView } from './presentation/presentationCanvasView';
import { PresentationRunController } from './presentation/presentationRunController';

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

    // Deck state — single source of truth (TD-SSR-02 foundation). Fields are
    // mutated in place via `this.deck.*`; pushVersion + the monotonic epoch live
    // on the store. See PresentationDeckStore.
    private readonly deck = new PresentationDeckStore();

    // Brand
    private brandEnabled = false;
    private brandTheme: BrandTheme | null = null;
    private brandAvailable = false;
    // F7 — live On-brand re-render scheduler (monotonic last-write-wins).
    // `brandReqId` is bumped on EVERY toggle request (incl. queued) so no stale
    // in-flight render can commit; `pendingBrand` holds the latest desired state
    // queued while a mutating op holds the lock or a render is in flight;
    // `lastRenderedBrandEnabled` is the reconcile baseline (the brand the current
    // deck.html was actually built with); `brandCheckboxEl` lets the failure
    // policy reconcile the checkbox from any path (toggle / flush / drain).
    private brandReqId = 0;
    private brandRendering = false;
    private pendingBrand: { brandEnabled: boolean; reqId: number } | null = null;
    private lastRenderedBrandEnabled = false;
    private brandCheckboxEl: HTMLInputElement | null = null;
    /** Latest ModalContext (stashed in renderContextPanel) so the run-controller
     *  release hook can flush a queued brand re-render without a ctx in scope. */
    private lastCtx: ModalContext | null = null;

    // Concurrency / run lifecycle — the single-flight lock, abort, thinking
    // sink, i18n bundle, and cancel hook now live in PresentationRunController
    // (TD-SSR-02 Phase 2). Accessed via this.run.*.

    // Single-flight guard for the per-slide polish modal: while a modal is
    // open, a second Polish click is a no-op rather than opening a duplicate
    // (audit-r2 H3). Cleared from the modal's onClose (audit-r3 H3).
    private activePolish: { modal: PolishSelectorModal } | null = null;

    // Cached slide fragment for the 1s elapsed ticker — lets the ticker
    // re-render progress without clobbering the slide-count text the
    // previous checkpoint wrote to the live region.
    private lastSlideFragment = '';

    /** Stable host for the version nav so restoreVersion can re-render it. */
    private versionNavHost: HTMLElement | null = null;

    // Project context
    private projectInstructions: string | null = null;
    private projectMemory: string[] = [];

    // Preview + filmstrip + slide-nav now live in PresentationCanvasView
    // (TD-SSR-02 Phase 5). The handler talks to the surface via this.canvas.*.

    // ── Scoped editing (slide-authoring-editing plan) ───────────────────────
    // Selection / editMode / editFlags + the chat-input accessory area now live
    // in EditScopeController (TD-SSR-02 Phase 6). The handler reads the active
    // scope from it in buildPrompt and routes element clicks into it.

    // ── Create-flow source state (slide-authoring-followup plan) ────────────
    // Lazily instantiated on first renderContextPanel call so we have access
    // to `ctx.app`. Disposed in `dispose()`. Subscription unsubscribe stored
    // for teardown when the create panel is replaced by the iframe.
    private sourceController: CreationSourceController | null = null;
    private creationFlowEpoch = 1;
    // Deep clone so nested config (arrays/objects) can never alias the shared
    // module default — a shallow spread would let one handler mutate the default.
    private creationConfig: CreationConfig = structuredClone(DEFAULT_CREATION_CONFIG);
    /** The creation epoch whose `planMode` has been seeded from settings. Ensures
     *  the per-deck Plan pill defaults from `presentationConsultantMode` ONCE per
     *  creation cycle, while a user pill click within the cycle is preserved. */
    private planModeSeededEpoch = -1;
    private createPanelDispose: (() => void) | null = null;

    // ── Collaborators (TD-SSR-02 decomposition) ─────────────────────────────
    private readonly run = new PresentationRunController();
    private readonly themeResolver = new PresentationThemeResolver();
    private readonly exporter = new PresentationExporter();
    /**
     * Consultant mode (review gate): after the storyline note is written, the
     * catalog + note path + deck name are held here so each subsequent send either
     * REVISES the storyline (chat request / doc comments) or BUILDS the deck — all
     * without re-resolving sources or re-running any web search. Cleared on build.
     */
    private pendingStoryline: { catalog: EvidenceSpan[]; notePath: string; deckName: string } | null = null;
    private readonly editScope = new EditScopeController({
        getOperation: () => this.deriveOperation(),
        isLocked: () => this.run.isLocked(),
        onActiveSlide: (i) => { this.deck.activeSlideIndex = i; },
    });
    private readonly canvas = new PresentationCanvasView(this.deck, {
        onElementSelect: (event) => this.editScope.selectFromEvent(event),
    });

    // ── Phase progress ──────────────────────────────────────────────────────

    /** Centralized phase setter that bubbles a phase-specific message to the
     *  chat "Thinking…" placeholder when an async action is active.
     *  Also re-renders the edit accessory so the create panel / edit pills
     *  reflect the new operation gate (audit Item 5). */
    private setPhase(phase: PresentationPhase): void {
        this.deck.phase = phase;
        const label = this.getPhaseMessage(phase);
        if (label) this.run.setThinking(label);   // no-op when no op owns the sink
        this.editScope.render();
    }

    /** After an aborted op, leave the deck in a STABLE phase so the side-panel
     *  status line doesn't stay stuck on a transient "Generating slides…" /
     *  "Refining…". An existing deck returns to preview; an empty create flow
     *  returns to the create panel. */
    private resetPhaseAfterCancel(): void {
        this.setPhase(this.deck.html ? 'preview-ready' : 'empty');
    }

    /** Human-readable label per presentation phase. Returns null for phases
     *  the user shouldn't see a thinking text for. (F4 — i18n-driven, falls
     *  back to English if no op-scoped i18n bundle has been registered yet.) */
    private getPhaseMessage(phase: PresentationPhase): string | null {
        const t = this.run.translations;
        switch (phase) {
            case 'storyboarding': return t?.phaseStoryboarding ?? 'Drafting storyline…';
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
        return this.deck.html
            ? t.modals.unifiedChat.placeholderPresentationRefine
            : t.modals.unifiedChat.placeholderPresentation;
    }


    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat;
        // Stash the latest ctx + register the lock-release flush so a brand
        // re-render queued mid-generation drains once the deck is free (F7).
        this.lastCtx = ctx;
        this.run.onRelease(() => this.flushPendingBrandRerender());
        // Register as the active target for global commands (e.g. the
        // slide-picker command bound to Mod+Shift+S). The registry tracks all
        // live handlers + unregisters cleanly on dispose (no dangling pointer).
        registerPresentationTarget(this);

        // F3: dispose any prior SlideIframePreview BEFORE clearing the DOM.
        // Previously this was nested inside the `if (this.deck.html)` recreate
        // branch — transitions to empty / error / non-preview states cleared
        // the container without ever calling dispose(), leaking the iframe
        // + its listeners.
        // F5: same for the navigate deferral — cancel before the container
        // goes away so it doesn't fire against a stale preview.
        // Dispose the canvas widgets (preview + filmstrip + provider) + cancel
        // the pending nav before container.empty() so nothing fires against
        // detached DOM. Recreated below via canvas.mount() when a deck exists.
        this.canvas.dispose();
        // Drop the accessory container ref before container.empty() so a
        // render can't fire against detached DOM during the transition window.
        this.editScope.unbind();
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
        if (!this.deck.html) {
            // Seed the per-deck Plan choice from the global default ONCE per creation
            // cycle (user pill clicks within the cycle override it; a new deck re-seeds).
            if (this.planModeSeededEpoch !== this.creationFlowEpoch) {
                this.creationConfig.planMode = ctx.fullPlugin.settings.presentationConsultantMode ? 'storyline' : 'direct';
                this.planModeSeededEpoch = this.creationFlowEpoch;
            }
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

        if (this.deck.phase === 'empty') return;

        // Slide preview
        if (this.deck.html) {
            // Edit-flow accessory area — selection pill + mode pills + flags.
            // Sits above the iframe so the user sees the active scope before
            // they type the edit. The controller owns the stable container ref
            // for in-place re-render on state changes.
            const accessoryHost = container.createEl('div', {
                cls: 'ai-organiser-pres-accessory-host',
            });
            this.editScope.bind(accessoryHost, t);

            // Canvas body: filmstrip (left) + preview (fills). Wrapping them in a
            // horizontal row keeps the filmstrip inside the canvas grid cell, so
            // the side-rail grid template (modebar/canvas/rail/actions) is untouched.
            const canvasBody = container.createEl('div', { cls: 'ai-organiser-pres-canvas-body' });
            // Canvas view builds the preview + filmstrip into canvasBody and
            // projects the deck (refreshPreview). Canonical HTML (no data-element
            // attrs) stays in this.deck.html for prompts/exports.
            this.canvas.mount(canvasBody, {
                slidePreviewEmpty: t.slidePreviewEmpty,
                slideBgHoverTooltip: t.slideBgHoverTooltipTemplate,
                slideThumbnails: ctx.plugin.t.presentationLayout.slideThumbnails,
                slideThumbnailItem: ctx.plugin.t.presentationLayout.slideThumbnailItem,
            });
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
        if (this.deck.phase === 'error' && this.deck.lastError) {
            const el = container.createEl('div', { cls: 'ai-organiser-pres-error' });
            el.textContent = this.deck.lastError;
        }
    }

    /** F4: single source of truth for side-panel status text, maps phase
     *  → i18n key. Returns null for phases with no visible status line. */
    private getPhaseStatusText(t: Translations['modals']['unifiedChat']): string | null {
        switch (this.deck.phase) {
            case 'storyboarding': return t.phaseStoryboarding;
            case 'generating': return t.phaseGenerating;
            case 'refining':   return t.phaseRefining;
            case 'auditing':   return t.phaseAuditing;
            case 'exporting':  return t.phaseExporting;
            default:           return null;
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
        if (opts.resetActiveSlide) this.deck.activeSlideIndex = 0;
        this.deck.deckIr = opts.deckIr;
        this.deck.html = opts.html;
        this.canvas.refreshPreview();
        this.deck.pushVersion(opts.versionLabel);
        this.updateReliability();
        this.runQualityCheck();
        this.editScope.clear();
        this.setPhase('preview-ready');
        void this.runBackgroundQualityScan(opts.llmCtx, opts.signal);
    }

    buildPrompt(query: string, history: string, ctx: ModalContext): Promise<SendResult> {
        if (this.run.isLocked()) {
            return Promise.resolve({ prompt: '', directResponse: ctx.plugin.t.modals.unifiedChat.presentationBusy });
        }

        return Promise.resolve({
            prompt: '',
            streamingSetup: {
                start: async (streamCb) => {
                    this.cancelActiveOperation();
                    // begin() takes the lock, mints the AbortController, and
                    // stashes the thinking sink + i18n for setPhase's lifetime.
                    const abort = this.run.begin((m) => streamCb.updateThinking?.(m), ctx.plugin.t.modals.unifiedChat);

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
                        if (!this.deck.html) {
                            return await this.runGenerate(runCtx);
                        }
                        const selection = this.editScope.getSelection();
                        if (selection) {
                            return await this.runScopedEdit(runCtx, selection, this.editScope.getEditMode(), this.editScope.getEditFlags());
                        }
                        return await this.runRefine(runCtx);
                    } finally {
                        this.run.end();
                    }
                },
            },
        });
    }

    // ── Generation + refinement (extracted to keep buildPrompt lean) ─────────

    private async runGenerate(r: RunContext): Promise<StreamingResult> {
        // Storyline-first decks draft a storyline before slides — show the right
        // phase from the start (a pending storyline that BUILDS resets to
        // 'generating' in handlePendingStoryline). Direct decks generate slides.
        this.setPhase(
            this.creationConfig.planMode === 'storyline' && !this.pendingStoryline
                ? 'storyboarding'
                : 'generating',
        );
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
            // Capture brand intent BEFORE any async resolve (Gemini-G1) so the deck
            // commit records the brand the HTML was actually built with, even if the
            // user toggles On-brand mid-generation.
            const requestedBrand = this.brandEnabled;
            const exportTheme = await this.themeResolver.resolve(r.ctx, requestedBrand);
            const settings = r.ctx.fullPlugin.settings;

            let irResult: Result<SlideDeckIr>;
            if (this.pendingStoryline) {
                // Consultant review gate: each send either revises the storyline (and
                // returns early, staying in review) or builds the deck. No source
                // re-resolution / web search.
                const res = await this.handlePendingStoryline(r);
                if ('early' in res) return { finalContent: res.early };
                irResult = res;
            } else {
                // Resolve attached sources (notes / web-search / folders) — this is
                // what actually runs the web search — and thread them into generation.
                let sources: PromptSource[] = [];
                if (this.sourceController) {
                    // Model-aware budget so substantial sources reach generation
                    // untruncated on cloud models, instead of a flat 40K-char cap.
                    const provider = settings.serviceType === 'local' ? 'local' : settings.cloudServiceType;
                    const totalBudgetChars = computeSourceBudgetChars(provider, settings.cloudModel);
                    // Option A: ground any web-search query in the deck's attached
                    // notes + prompt before dispatching (gated; default on).
                    const groundWebSearchQuery = settings.presentationGroundWebSearch
                        ? this.buildWebSearchGrounder(r.llmCtx)
                        : undefined;
                    const resolved = await this.sourceController.resolveForSubmit({
                        signal: r.abort.signal,
                        totalBudgetChars,
                        groundWebSearchQuery,
                        deckDescription: r.originalQuery,
                    });
                    if (resolved.ok) sources = resolved.value.usable;
                }
                if (this.creationConfig.planMode === 'storyline') {
                    // Per-deck Plan = storyline: write a grounded storyline (ghost deck)
                    // first; gate='review' opens it for sign-off and returns early.
                    const consultant = await this.runConsultantStage(r, sources);
                    if ('early' in consultant) return { finalContent: consultant.early };
                    irResult = consultant;
                } else {
                    irResult = await generateDeckIr(r.llmCtx, {
                        userQuery: r.effectiveQuery,
                        noteContent: r.noteContent,
                        conversationHistory: r.history,
                        outputLanguage: settings.summaryLanguage,
                        targetLength: this.creationConfig.length,
                        audience: this.creationConfig.audience,
                        sources,
                        signal: r.abort.signal,
                        // D6: a 429 backoff surfaces as a status line in the thinking sink.
                        onRetryStatus: (seconds) => this.run.setThinking(
                            r.ctx.plugin.t.llmGateway.statusRateLimited.replace('{seconds}', String(seconds)),
                        ),
                    });
                }
            }
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!irResult.ok) {
                logger.error('Presentation', `[IR-gen] generation failed: ${irResult.error}`);
                this.setPhase('error');
                this.deck.lastError = irResult.error;
                return { finalContent: t.slideGenerateFailed.replace('{error}', irResult.error) };
            }

            const built = buildHtmlFromDeckIr(
                irResult.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage,
                r.ctx.plugin.t.progress.presentation.slideRenderFailed,
            );
            if (!built.ok) {
                logger.error('Presentation', `[IR-gen] IR→HTML render failed: ${built.error}`);
                this.setPhase('error');
                this.deck.lastError = built.error;
                return { finalContent: t.slideGenerateFailed.replace('{error}', built.error) };
            }

            this.commitNewDeck({
                ir: irResult.value,
                builtHtml: built.value,
                label: r.originalQuery,
                renderedBrandEnabled: requestedBrand,
            });

            if (this.brandEnabled && r.theme.auditChecklist.length > 0) {
                this.setPhase('auditing');
                await this.runAudit(r.llmCtx, r.theme, r.abort.signal);
            }

            this.runQualityCheck();
            this.setPhase('preview-ready');
            // Storyline (consultant) decks (Cluster D): route the visual quality scan
            // through the INDEPENDENT visual critic (a different model family) so the
            // layout review is independent of the generator; direct decks use main.
            const scanCtx = this.creationConfig.planMode === 'storyline'
                ? (await this.resolveRoleRun(r, 'visual_critic')).context
                : r.llmCtx;
            void this.runBackgroundQualityScan(scanCtx, r.abort.signal);

            const title = extractDeckTitle(built.value);
            const count = countSlides(built.value);
            return { finalContent: `Created "${title}" with ${count} slides. Describe changes to refine, or export when ready.` };
        } catch (e) {
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Presentation', `[IR-gen] threw: ${msg}`);
            this.setPhase('error');
            this.deck.lastError = msg;
            return { finalContent: t.slideGenerateFailed.replace('{error}', msg) };
        } finally {
            // Aborted runs return early above without committing — clear the
            // transient 'generating' phase so the side-panel status line doesn't
            // linger on "Generating slides…" after cancel. (Success → already
            // 'preview-ready'; non-abort failure → 'error'; both left intact.)
            if (r.abort.signal.aborted) this.resetPhaseAfterCancel();
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }

    // ── Consultant-quality pipeline (plan Cluster A + B) ─────────────────────

    /**
     * Resolve the storyboard-generator role (plan Cluster B) to the LLM context +
     * model to run it on. Default ("Main") → the modal's main context, no override.
     * A same-provider override switches the model via `modelOverride`; a cross-provider
     * choice builds a specialist `CloudLLMService`. Any gap (no key / local / missing
     * endpoint) degrades gracefully to Main. Never throws.
     */
    private async resolveRoleRun(r: RunContext, role: PresentationRole): Promise<{ context: LLMFacadeContext; modelOverride: string }> {
        const plugin = r.ctx.fullPlugin;
        const s = plugin.settings;
        const hasKey = (p: AdapterType) => !!(s.providerSettings?.[p]?.apiKey || (s.cloudServiceType === p && s.cloudApiKey));
        const profile = await resolveProviderProfile(plugin);
        const resolved = resolvePresentationRole(role, { profile, roles: s.presentationModelRoles, hasKey });
        if (!resolved.ok) return { context: r.llmCtx, modelOverride: '' };
        const resolvedRole = resolved.value;
        if (resolvedRole.warning) logger.warn('Presentation', `${role} role: ${resolvedRole.warning}`);
        if (!resolvedRole.crossProvider) return { context: r.llmCtx, modelOverride: resolvedRole.modelOverride };
        if (resolvedRole.provider === 'local') return { context: r.llmCtx, modelOverride: '' };
        const apiKey = s.providerSettings?.[resolvedRole.provider]?.apiKey || (s.cloudServiceType === resolvedRole.provider ? s.cloudApiKey : '') || '';
        if (!apiKey) return { context: r.llmCtx, modelOverride: '' };
        const endpoint = PROVIDER_ENDPOINT[resolvedRole.provider] || '';
        const service = new CloudLLMService({ type: resolvedRole.provider, apiKey, modelName: resolvedRole.resolvedModel, endpoint }, r.ctx.app);
        if (s.debugMode) service.setDebugMode(true);
        return { context: { llmService: service, settings: s }, modelOverride: '' };
    }

    /**
     * Build the independent-critic `StoryboardJudge` (plan Cluster D) bound to the
     * resolved critic role (a DIFFERENT model family from the generator, per the
     * resolver's independence invariant). Returns undefined if the critic can't be
     * resolved — the deterministic structural audit then stands alone.
     */
    private async buildCritic(r: RunContext, catalog: EvidenceSpan[]): Promise<StoryboardJudge> {
        const critic = await this.resolveRoleRun(r, 'structural_critic');
        return buildStoryboardJudge(critic.context, catalog, {
            signal: r.abort.signal,
            outputLanguage: r.ctx.fullPlugin.settings.summaryLanguage,
            ...(critic.modelOverride ? { modelOverride: critic.modelOverride } : {}),
        });
    }

    /**
     * Run the storyboard stage: build the evidence catalog from the resolved
     * sources, generate a grounded + audited storyboard, then either (review gate)
     * write the dot-dash storyline note for sign-off and signal an early return,
     * or (auto-build) translate straight to a deck IR. Never throws.
     */
    private async runConsultantStage(r: RunContext, sources: PromptSource[]): Promise<{ early: string } | Result<SlideDeckIr>> {
        const settings = r.ctx.fullPlugin.settings;
        const t = r.ctx.plugin.t.modals.unifiedChat;
        // Storyline drafting, not slide generation — surface the right phase label
        // (the side panel + thinking indicator otherwise say "Generating slides…").
        this.setPhase('storyboarding');
        // Model-aware char budget so the catalog (and thus the prompt) stays bounded
        // for the configured model / Azure TPM, instead of an unbounded injection (audit H12).
        const provider = settings.serviceType === 'local' ? 'local' : settings.cloudServiceType;
        const catalog = buildEvidenceCatalog([
            ...(r.noteContent ? [{ ref: 'active note', content: r.noteContent }] : []),
            ...sources.map((s) => ({ ref: s.ref, content: s.content })),
        ], { maxTotalChars: computeSourceBudgetChars(provider, settings.cloudModel) });
        const gen = await this.resolveRoleRun(r, 'storyboard_generator');
        const judge = await this.buildCritic(r, catalog);
        const stage = await runStoryboardStage(gen.context, r.effectiveQuery, catalog, {
            outputLanguage: settings.summaryLanguage,
            targetLength: this.creationConfig.length,
            signal: r.abort.signal,
            deckName: r.originalQuery,
            modelOverride: gen.modelOverride,
            judge,
            onRetryStatus: (seconds) => this.run.setThinking(
                r.ctx.plugin.t.llmGateway.statusRateLimited.replace('{seconds}', String(seconds)),
            ),
        });
        if (!stage.ok) return err(stage.error);

        if (settings.presentationStorylineGate === 'review') {
            try {
                const notePath = await this.writeStorylineNote(r.ctx, stage.value.storylineMarkdown, r.originalQuery);
                this.pendingStoryline = { catalog, notePath, deckName: r.originalQuery };
                const name = notePath.split('/').pop() ?? notePath;
                // Post the storyline IN the chat for conversational iteration; the
                // note is the auto-saved background copy.
                return { early: `${stage.value.storylineMarkdown}\n\n---\n\n${t.storylineReady.replace('{name}', name)}` };
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error('Presentation', `[storyline] note write failed: ${msg}`);
                return { early: t.storylineWriteFailed.replace('{error}', msg) };
            }
        }
        // auto-build: storyboard → IR directly (no markdown round-trip).
        return buildDeckFromStoryboard(stage.value.storyboard);
    }

    /**
     * Review-gate iteration: each send while a storyline is pending either BUILDS
     * the deck (a clear build/approval command) or REVISES the storyline (any other
     * message + the doc's reviewer comments) and stays in review. Builds clear the
     * pending state; revisions and failures keep it so the user can keep iterating
     * or fix the doc. `{ early }` = return this chat message now (no deck this turn).
     */
    private async handlePendingStoryline(r: RunContext): Promise<{ early: string } | Result<SlideDeckIr>> {
        const pending = this.pendingStoryline;
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!pending) return err('no pending storyline');
        const file = r.ctx.app.vault.getAbstractFileByPath(pending.notePath);
        if (!(file instanceof TFile)) {
            this.pendingStoryline = null;
            return err(t.storylineBuildFailed.replace('{error}', 'the storyline note was moved or deleted'));
        }
        const md = await r.ctx.app.vault.read(file);
        const request = r.originalQuery;

        if (looksLikeBuildCommand(request)) {
            // BUILD: re-read + re-ground the (possibly edited) note, then translate.
            const built = buildDeckFromStoryline(md, pending.catalog, r.ctx.fullPlugin.settings.summaryLanguage);
            if (!built.ok) return err(t.storylineBuildFailed.replace('{error}', built.error));
            this.pendingStoryline = null;
            return ok(built.value.deck);
        }

        // REVISE: apply the request + any reviewer comments, re-ground/audit,
        // rewrite the note in place, and stay in review for the next turn.
        this.setPhase('storyboarding');  // revising the storyline, not generating slides
        const parsed = markdownToStoryboard(md);
        if (!parsed.ok) return { early: t.storylineReviseFailed.replace('{error}', parsed.error) };
        const gen = await this.resolveRoleRun(r, 'storyboard_generator');
        const judge = await this.buildCritic(r, pending.catalog);
        const revised = await reviseStoryboard(gen.context, parsed.value.storyboard, request, parsed.value.comments, pending.catalog, {
            outputLanguage: r.ctx.fullPlugin.settings.summaryLanguage,
            deckName: pending.deckName,
            signal: r.abort.signal,
            modelOverride: gen.modelOverride,
            judge,
            onRetryStatus: (seconds) => this.run.setThinking(
                r.ctx.plugin.t.llmGateway.statusRateLimited.replace('{seconds}', String(seconds)),
            ),
        });
        if (r.abort.signal.aborted) return { early: t.generationCancelled };
        if (!revised.ok) return { early: t.storylineReviseFailed.replace('{error}', revised.error) };
        await r.ctx.app.vault.modify(file, revised.value.storylineMarkdown);
        const name = pending.notePath.split('/').pop() ?? pending.notePath;
        // Re-post the revised storyline in the chat so iteration stays conversational.
        return { early: `${revised.value.storylineMarkdown}\n\n---\n\n${t.storylineRevised.replace('{name}', name)}` };
    }

    /** Write the dot-dash storyline `.md` to the presentation output folder + open it. */
    private async writeStorylineNote(ctx: ModalContext, markdown: string, title: string): Promise<string> {
        const sub = ctx.plugin.settings.presentationOutputFolder || 'Presentations';
        const folder = `${ctx.plugin.settings.pluginFolder}/${sub}`;
        if (!ctx.app.vault.getAbstractFileByPath(folder)) await ctx.app.vault.createFolder(folder);
        const safe = (title || 'Storyline').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Storyline';
        let path = `${folder}/${safe} — storyline.md`;
        for (let i = 1; ctx.app.vault.getAbstractFileByPath(path) && i <= 999; i++) {
            path = `${folder}/${safe} — storyline ${i}.md`;
        }
        await ctx.app.vault.create(path, markdown);
        // Auto-saved, NOT force-opened: the storyline is reviewed/iterated IN the
        // chat (it's posted as the assistant's reply); the .md is the synced
        // background artifact (survives modal close + hand-editable if the user
        // navigates to it), not a pane shoved in front of them.
        return path;
    }

    /** Polish an IR-backed deck by refining the IR (keeps it canonical). */
    private async polishDeckIr(
        ctx: ModalContext,
        llmCtx: LLMFacadeContext,
        theme: BrandTheme,
        abort: AbortController,
    ): Promise<void> {
        if (!this.deck.deckIr) return;
        this.runQualityCheck();
        const findings = this.deck.qualityResult?.findings ?? [];
        const polishRequest = findings.length > 0
            ? `Polish the deck. Improve clarity and fix these issues:\n${findings
                .map(f => `[${f.severity}] ${f.slideIndex !== undefined ? `Slide ${f.slideIndex + 1}: ` : ''}${f.issue} → ${f.suggestion}`)
                .join('\n')}`
            : 'Polish the deck: tighten wording, sharpen the visual hierarchy, and ensure one idea per slide. Keep the facts and the slide count unchanged.';
        const exportTheme = await this.themeResolver.resolve(ctx, this.brandEnabled);
        const refined = await refineDeckIr(llmCtx, {
            currentDeck: this.deck.deckIr,
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
        if (!this.deck.deckIr) return { finalContent: t.slideRefineNoDeck };
        const controller = this.createProgressController(
            r.abort, r.streamCb, t, REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS, undefined,
        );
        this.renderProgress(r.streamCb, t, 0, undefined, 0);
        const elapsedTimer = this.startElapsedTicker(controller, r.streamCb, t, undefined);
        try {
            const exportTheme = await this.themeResolver.resolve(r.ctx, this.brandEnabled);
            const refined = await refineDeckIr(r.llmCtx, {
                currentDeck: this.deck.deckIr,
                userRequest: r.effectiveQuery,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                signal: r.abort.signal,
            });
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!refined.ok) {
                logger.error('Presentation', `[IR-refine] failed: ${refined.error}`);
                this.setPhase('error');
                this.deck.lastError = refined.error;
                return { finalContent: t.slideRefineFailed.replace('{error}', refined.error) };
            }
            const built = buildHtmlFromDeckIr(refined.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage, r.ctx.plugin.t.progress.presentation.slideRenderFailed);
            if (!built.ok) {
                logger.error('Presentation', `[IR-refine] IR→HTML failed: ${built.error}`);
                this.setPhase('error');
                this.deck.lastError = built.error;
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
            this.deck.lastError = msg;
            return { finalContent: t.slideRefineFailed.replace('{error}', msg) };
        } finally {
            if (r.abort.signal.aborted) this.resetPhaseAfterCancel();
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }

    private async runRefine(r: RunContext): Promise<StreamingResult> {
        this.setPhase('refining');
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.deck.html || !this.deck.deckIr) return { finalContent: t.slideRefineNoDeck };
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
        if (!this.deck.html || !this.deck.deckIr) return { finalContent: t.slideEditNoDeck };

        // Targeted edit is now an IR slice-refine on the selected slide(s) —
        // IR-native (the deck stays canonical) and consistent with per-slide
        // Polish. Element-level precision degrades to slide-level; undo via the
        // version timeline. (Web-search-in-scoped-edit + DOM drift detection
        // were HTML-path features dropped with the legacy engine.)
        const start = scope.slideIndex;
        const end = scope.kind === 'range' && scope.slideEndIndex !== undefined ? scope.slideEndIndex : start;
        const indices: number[] = [];
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            if (i >= 0 && i < this.deck.deckIr.slides.length) indices.push(i);
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
                currentDeck: this.deck.deckIr,
                selections: indices.map(slideIndex => ({ slideIndex, instruction })),
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                signal: r.abort.signal,
            });
            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };
            if (!refined.ok) {
                logger.error('Presentation', `[IR-scoped-edit] failed: ${refined.error}`);
                this.setPhase('error');
                this.deck.lastError = refined.error;
                return { finalContent: t.slideEditFailed.replace('{error}', refined.error) };
            }
            const exportTheme = await this.themeResolver.resolve(r.ctx, this.brandEnabled);
            const built = buildHtmlFromDeckIr(refined.value, exportTheme, r.theme.css, r.ctx.plugin.settings.summaryLanguage, r.ctx.plugin.t.progress.presentation.slideRenderFailed);
            if (!built.ok) {
                this.setPhase('error');
                this.deck.lastError = built.error;
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
            this.deck.lastError = msg;
            return { finalContent: t.slideEditFailed.replace('{error}', msg) };
        } finally {
            if (r.abort.signal.aborted) this.resetPhaseAfterCancel();
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
                this.run.consumeCancelHook();
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
            onRegisterCancelHook: (fn) => { this.run.registerCancelHook(fn); },
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
        const hasDeck = !!this.deck.html;
        const ready = this.deck.phase === 'preview-ready';
        const locked = this.run.isLocked();

        // Consultant review gate: while a storyline is pending (no deck yet), the
        // primary CTA is "Create deck" — an explicit affordance for the build step
        // that otherwise requires typing "build" into chat. Builds from the
        // (possibly user-edited) storyline note using the on-screen create-panel
        // settings (brand applied at build; slide-count/sources shaped the storyline).
        if (this.pendingStoryline && !hasDeck) {
            return [{
                id: 'create-deck-from-storyline',
                labelKey: 'Create deck',
                tooltipKey: 'Build the slide deck from the storyline above (apply your On-brand + export settings)',
                isEnabled: !locked,
                requiresEditor: false,
                isDefault: true,
            }];
        }

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
                // NOT the CTA: the primary action is the send arrow (generate /
                // refine). A secondary "save" shouldn't be the loudest button.
                isDefault: false,
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
            case 'create-deck-from-storyline': return this.handleCreateDeckFromStoryline(ctx, callbacks);
            case 'export-pptx': return this.exportPptx(ctx, callbacks);
            case 'export-html': return this.exportHtmlFile(ctx, callbacks);
            case 'check-brand': return this.handleBrandAudit(ctx, callbacks);
            case 'polish': return this.handlePolish(ctx, callbacks);
            case 'discard': return this.handleDiscard(callbacks);
        }
    }

    /** "Create deck" button (consultant review gate): build the deck from the
     *  pending storyline note via the shared build path, then re-render the
     *  context panel so the create panel is replaced by the deck preview. */
    private async handleCreateDeckFromStoryline(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        const pending = this.pendingStoryline;
        if (!pending) { callbacks.notify(ctx.plugin.t.modals.unifiedChat.storylineNoteRequired); return; }
        await this.buildFromStorylineNote(ctx, pending.notePath);
        // buildFromStorylineNote clears pendingStoryline + sets the deck on success;
        // re-render so the side panel switches from the create form to the preview.
        callbacks.rerenderContext?.();
    }

    onClear(): void {
        this.cancelActiveOperation();
        this.canvas.clearNavigateTimeout();  // F5
        this.deck.html = null;
        this.deck.deckIr = null;
        this.deck.versions = [];
        this.deck.versionIndex = -1;
        this.deck.activeSlideIndex = 0;
        this.deck.qualityResult = null;
        this.deck.lastError = null;
        this.deck.phase = 'empty';
        // Scoped-editing state — clear selection and reset mode/flags so a
        // fresh deck doesn't inherit stale scope from the previous one.
        this.editScope.reset();
        // Increment epoch + reset source controller so the next creation
        // cycle starts clean and conversation history from the prior cycle
        // can be filtered out of generation prompts (audit Gemini-r2-G3 +
        // r5-G3 + r6-G1).
        this.creationFlowEpoch++;
        if (this.sourceController) this.sourceController.reset();
        this.creationConfig = structuredClone(DEFAULT_CREATION_CONFIG);
    }

    dispose(): void {
        this.cancelActiveOperation();
        this.canvas.dispose();
        this.editScope.dispose();
        this.versionNavHost = null;
        if (this.createPanelDispose) {
            this.createPanelDispose();
            this.createPanelDispose = null;
        }
        if (this.sourceController) {
            this.sourceController.dispose();
            this.sourceController = null;
        }
        this.creationFlowEpoch++;
        unregisterPresentationTarget(this);
    }

    /** Public seam for the global slide-picker command (Mod+Shift+S).
     *  Returns true if the picker was opened, false if no deck is loaded. */
    hasDeck(): boolean {
        return this.deck.html !== null;
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
            hasDeck: this.deck.html !== null && this.deck.phase !== 'empty',
            deckVersion: this.deck.deckEpoch,
        };
    }

    /** Used by the slide-picker command to read deck HTML. */
    getDeckHtml(): string | null {
        return this.deck.html;
    }

    /** Set selection from outside (slide-picker command, Mod+Shift+S). Updates
     *  the edit-scope selection AND scrolls the preview to the picked slide —
     *  unlike the iframe-click path (where the clicked slide is already in view),
     *  a command-palette pick must navigate the preview there (TD-SSR-05). */
    selectSlideFromCommand(slideIndex: number): void {
        if (!this.deck.html) return;
        this.deck.activeSlideIndex = slideIndex;
        this.canvas.navigateToSlide(slideIndex);
        this.editScope.setSelection({ kind: 'slide', slideIndex });
    }

    /** Test seam — exposed for unit tests that drive the handler without going
     *  through the iframe's postMessage path. Forwards to the edit-scope controller. */
    setSelectionForTesting(scope: SelectionScope | null): void {
        this.editScope.setSelectionForTesting(scope);
    }

    /** Test seam — read the current selection without mutating. */
    getSelection(): SelectionScope | null {
        return this.editScope.getSelection();
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

    /**
     * Build the Option-A web-search query grounder: an LLM call that rewrites
     * the user's literal search query into one anchored in the deck's prompt +
     * attached note excerpts. Returns a function that NEVER throws — the source
     * service falls back to the literal query on any failure (the `summarizeText`
     * facade already wraps errors into a non-throwing Result, and we clamp/guard
     * the output here so a junk response degrades to the literal query).
     */
    private buildWebSearchGrounder(llmCtx: LLMFacadeContext): WebSearchGroundingFn {
        return async (literalQuery, context, signal) => {
            const prompt = buildWebSearchGroundingPrompt({
                literalQuery,
                description: context.description,
                noteExcerpts: context.noteExcerpts,
            });
            const res = await summarizeText(llmCtx, prompt, { signal, maxTokens: 200 });
            if (!res.success || !res.content) return literalQuery;
            // Collapse to a single line and clamp — the prompt asks for a bare
            // query, but defend against a chatty model returning prose.
            const cleaned = res.content.trim().split('\n')[0].trim().slice(0, GROUNDED_QUERY_MAX_CHARS);
            return cleaned || literalQuery;
        };
    }

    // ── Selection state ─────────────────────────────────────────────────────
    // Owned by EditScopeController (TD-SSR-02 Phase 6). The preview's
    // onElementSelect routes into `editScope.selectFromEvent`; the pipeline
    // reads scope via `editScope.getSelection/getEditMode/getEditFlags`.

    /** Map the existing PresentationPhase to the two-axis (deckPresence,
     *  operation) view from the plan. Used by the accessory renderer to
     *  decide whether pills are interactive or disabled-with-spinner. */
    private deriveOperation(): 'idle' | 'applying' | 'error' {
        switch (this.deck.phase) {
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
        if (!this.deck.html) return null;
        return {
            schemaVersion: 1,
            html: this.deck.html,
            versions: this.deck.versions,
            conversation: [],
            brandEnabled: this.brandEnabled,
            // Persist the deck IR so a faithful native PPTX export + further
            // IR editing survive a reload.
            deckIr: this.deck.deckIr ?? undefined,
            createdAt: this.deck.versions[0]?.timestamp
                ? new Date(this.deck.versions[0].timestamp).toISOString()
                : new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
        };
    }

    restoreState(data: unknown): boolean {
        const session = migratePresentationSession(data);
        if (!session) return false;

        this.deck.html = session.html;
        // Rehydrate the persisted deck IR (validated). New sessions always carry
        // it; a legacy session saved before structured editing loads view-only
        // (deckIr null → IR refine/polish guard out gracefully, and PPTX export
        // falls through to the dom-to-pptx path on the restored HTML).
        const rawIr = (data as { deckIr?: unknown } | null)?.deckIr;
        const validated = rawIr != null ? validateDeckIr(rawIr) : null;
        this.deck.deckIr = validated?.ok ? validated.value : null;
        this.deck.versions = session.versions.slice(0, MAX_VERSIONS);
        this.deck.versionIndex = this.deck.versions.length - 1;
        this.brandEnabled = session.brandEnabled;
        this.deck.activeSlideIndex = 0;
        this.deck.phase = 'preview-ready';
        this.deck.deckEpoch++;   // a restored session is a fresh deck — invalidate any cache
        return true;
    }

    // ── Export: PPTX via dom-to-pptx ────────────────────────────────────────

    private async exportPptx(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        // Phase 1B F8: replace silent returns with user-visible notices so
        // broken-state clicks don't look like the button is dead.
        if (!this.deck.html) {
            callbacks.notify('Can\'t export — no presentation generated yet.');
            return;
        }
        if (this.run.isLocked()) {
            callbacks.notify('Can\'t export right now — generation / refinement in progress.');
            return;
        }
        if (!this.canvas.isReady()) {
            callbacks.notify('Preview not ready — click into the slide panel once, then retry export.');
            return;
        }
        this.run.lock();
        this.setPhase('exporting');
        callbacks.rerenderActions();

        try {
            const iframeDoc = this.canvas.getIframeDocument();
            if (!iframeDoc) throw new Error('iframe not ready');

            // Show all slides for export (remove nav-hidden class)
            const allSlides = Array.from(iframeDoc.querySelectorAll<HTMLElement>('.slide'));
            allSlides.forEach(s => s.classList.remove('pres-nav-hidden'));

            const theme = await this.themeResolver.resolve(ctx, this.brandEnabled);
            // Resolve brand assets (icons/logo) ONCE up front — bounded to the
            // icon concepts the deck actually references (plan §5a). The pure IR
            // renderer consumes the pre-resolved PNGs; warnings surface to the log.
            const brandAssets = await this.resolveBrandAssetsForExport(ctx);
            await this.exporter.exportPptx({ html: this.deck.html, deckIr: this.deck.deckIr, theme, allSlides, ctx, ...(brandAssets ? { brandAssets } : {}) });

            // Restore single-slide view
            this.canvas.navigateToSlide(this.deck.activeSlideIndex);

            callbacks.notify('Exported to PPTX — check your downloads folder.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.notify(`PPTX export failed: ${msg}`);
            logger.error('Presentation', `PPTX export failed: ${msg}`);
        } finally {
            this.setPhase('preview-ready');
            this.run.unlock();
            callbacks.rerenderActions();
        }
    }

    /**
     * Resolve brand assets (icons by concept, both variants) for the current
     * deck — bounded to the icons the deck references (plan §5a G1). Off-brand →
     * returns undefined (no assets). Never throws; on a resolver error it logs
     * and degrades to Lucide-only.
     */
    private async resolveBrandAssetsForExport(ctx: ModalContext): Promise<ResolvedBrandAssets | undefined> {
        if (!this.brandEnabled) return undefined;
        try {
            const concepts = collectDeckIconConcepts(this.deck.deckIr);
            const theme = await this.themeResolver.resolve(ctx, this.brandEnabled);
            const result = await resolveBrandRenderContext(
                ctx.app, ctx.fullPlugin.settings, this.brandEnabled, concepts, theme,
            );
            if (!result.ok) {
                logger.warn('Presentation', `brand render context failed: ${result.error}`);
                return undefined;
            }
            for (const w of result.value.warnings) logger.warn('Presentation', `brand: ${w}`);
            return result.value.assets;
        } catch (e) {
            logger.warn('Presentation', `brand asset resolution failed: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    }

    // ── Export: HTML ─────────────────────────────────────────────────────────

    private async exportHtmlFile(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        // Phase 1B F8: same treatment as exportPptx — user-visible notices.
        if (!this.deck.html) {
            callbacks.notify('Can\'t save — no presentation generated yet.');
            return;
        }
        if (this.run.isLocked()) {
            callbacks.notify('Can\'t save right now — generation / refinement in progress.');
            return;
        }
        this.run.lock();
        this.setPhase('exporting');
        callbacks.rerenderActions();

        try {
            const path = await this.exporter.writeHtml(ctx, this.deck.html);
            callbacks.notify(`Saved to ${path}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.notify(`HTML export failed: ${msg}`);
        } finally {
            this.setPhase('preview-ready');
            this.run.unlock();
            callbacks.rerenderActions();
        }
    }

    // ── Brand Audit ─────────────────────────────────────────────────────────

    private async handleBrandAudit(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (!this.deck.html || !this.brandEnabled) return;
        if (!this.assertNotBusy(ctx, callbacks)) return;   // F4: busy feedback (was a silent return)
        const deckHtml = this.deck.html; // guarded non-null above
        // Abort any prior in-flight op BEFORE begin() mints the new controller,
        // so the cancel can't abort our own fresh signal.
        this.cancelActiveOperation();
        const abort = this.run.begin((m) => callbacks.showThinking(m), ctx.plugin.t.modals.unifiedChat);
        this.setPhase('auditing');
        callbacks.rerenderActions();

        // D3: hold the foreground gate so background indexing yields during the build.
        await ctx.fullPlugin.withForeground(async () => {
        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);

            const result = await runBrandAudit(llmCtx, deckHtml, theme, abort.signal);
            if (abort.signal.aborted) return;

            if (result.ok && result.value.violations.length > 0) {
                this.canvas.applyDomFixes(result.value.violations);
                callbacks.notify(
                    `Brand audit: ${result.value.violations.length} fix(es) applied.`
                );
            } else if (result.ok) {
                callbacks.notify('Brand audit: all checks passed.');
            } else {
                // Audit returned a failure Result (e.g. the LLM call timed out
                // or was rate-limited). Surface it — a silent "checking…" that
                // ends with no message reads as a hang to the user.
                callbacks.notify(`Brand audit could not complete: ${result.error}. Please try again.`);
            }

            this.runQualityCheck(result.ok ? result.value.violations.length : 0);
            this.setPhase('preview-ready');
        } catch (e) {
            if (!abort.signal.aborted) {
                this.setPhase('error');
                this.deck.lastError = e instanceof Error ? e.message : 'Audit failed';
                callbacks.notify(`Brand audit failed: ${this.deck.lastError}. Please try again.`);
            }
        } finally {
            this.run.end();
            callbacks.hideThinking();
            callbacks.rerenderActions();
        }
        });
    }

    private async runAudit(llmCtx: LLMFacadeContext, theme: BrandTheme, signal: AbortSignal): Promise<void> {
        if (!this.deck.html) return;
        const result = await runBrandAudit(llmCtx, this.deck.html, theme, signal);
        if (result.ok && result.value.violations.length > 0 && this.canvas.isReady()) {
            // Fixes will be applied once preview renders
            // Store for later application
            this.pendingFixes = result.value.violations;
        }
    }

    private pendingFixes: import('../../services/chat/presentationTypes').DomFix[] = [];

    // ── Polish ──────────────────────────────────────────────────────────────

    private async handlePolish(ctx: ModalContext, callbacks: ActionCallbacks): Promise<void> {
        if (this.activePolish) return;                       // single-flight: modal already open
        if (!this.deck.html) return;
        if (!this.assertNotBusy(ctx, callbacks)) return;     // F4: busy feedback (was a silent return)

        // Per-slide polish: a deck with >1 slide opens the selector modal so the
        // user can target specific slides; a single-slide deck polishes whole.
        if (this.deck.deckIr !== null && this.deck.deckIr.slides.length > 1) {
            // Run the autodetect quality scan first so the per-slide polish
            // boxes prefill with detected issues — the per-slide findings come
            // from the LLM fast scan, which may not have finished after
            // generation. Skip if we already have per-slide findings.
            if (!this.hasPerSlideFindings() && !this.run.isLocked()) {
                this.run.lock();
                callbacks.showThinking(ctx.plugin.t.modals.polishSelector.analysingLabel);
                callbacks.rerenderActions();
                try {
                    await this.ensureQualityFindings(ctx);
                } finally {
                    this.run.unlock();
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
        return (this.deck.qualityResult?.findings ?? []).some(f => f.slideIndex !== undefined);
    }

    /** Run the autodetect quality scan (structural pass → LLM fast scan) so
     *  `this.deck.qualityResult.findings` carries per-slide issues before the polish
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
        if (!this.deck.html || this.run.isLocked()) return;
        // Abort any prior in-flight op before begin() mints the new controller.
        this.cancelActiveOperation();
        const abort = this.run.begin((m) => callbacks.showThinking(m), ctx.plugin.t.modals.unifiedChat);
        this.setPhase('refining');
        callbacks.rerenderActions();

        // D3: hold the foreground gate so background indexing yields during the build.
        await ctx.fullPlugin.withForeground(async () => {
        try {
            const llmCtx = this.getLLMContext(ctx);
            const theme = await this.getTheme(ctx);

            // The deck is always IR-backed — polish via the IR (keeps export
            // faithful). polishDeckIr runs the autodetect scan + general/issue
            // refine and routes through commitDeckMutation.
            if (this.deck.deckIr) {
                await this.polishDeckIr(ctx, llmCtx, theme, abort);
            }

            if (this.brandEnabled && theme.auditChecklist.length > 0 && !abort.signal.aborted) {
                this.setPhase('auditing');
                await this.runAudit(llmCtx, theme, abort.signal);
            }

            this.runQualityCheck();
            // Whole-deck mutation invalidates positional selection paths.
            // Plan §"State transitions" mandates clearing on every html mutation.
            this.editScope.clear();
            this.setPhase('preview-ready');
            callbacks.notify(
                `Polish complete. Quality: ${this.deck.qualityResult?.totalScore ?? '?'}/100`
            );
        } catch (e) {
            if (!abort.signal.aborted) {
                this.setPhase('error');
                this.deck.lastError = e instanceof Error ? e.message : 'Polish failed';
                callbacks.notify(`Polish failed: ${this.deck.lastError}`);
            }
        } finally {
            this.run.end();
            callbacks.hideThinking();
            callbacks.rerenderActions();
        }
        });
    }

    /** Open the per-slide polish selector for a multi-slide IR deck. The modal
     *  owns its own submitting/error UI; the handler only mutates deck state
     *  after a Result.ok from `runPolishSubmit` (plan §4.2b). */
    private openPolishSelector(ctx: ModalContext, callbacks: ActionCallbacks): void {
        const llmCtx = this.getLLMContext(ctx);
        const deck = this.deck.deckIr!;
        // Local view of findings — NO mutation of this.deck.qualityResult here
        // (audit-r2 H1 + r3 H5). A null scan simply yields empty placeholders.
        const findings = this.deck.qualityResult?.findings ?? [];
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
        const deckWideFindings = (this.deck.qualityResult?.findings ?? []).filter(f => f.slideIndex === undefined);
        const compute = await withProgressResult<{ refined: SlideDeckIr; html: string }, 'polishing'>(
            {
                plugin: ctx.fullPlugin,
                initialPhase: { key: 'polishing' },
                resolvePhase: () => tSlice.progressLabel,
            },
            async () => {
                const refined = await refineDeckIrSelective(llmCtx, {
                    currentDeck: this.deck.deckIr!,
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
                const exportTheme = await this.themeResolver.resolve(ctx, this.brandEnabled);
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

    private restoreVersion(index: number): void {
        if (index < 0 || index >= this.deck.versions.length) return;
        const version = this.deck.versions[index];
        this.deck.html = version.html;
        // Restore the version's IR snapshot so the deck stays IR-backed (and
        // editable/exportable). Versions captured post-IR always carry it.
        this.deck.deckIr = version.deckIr ?? null;
        this.deck.activeSlideIndex = version.activeSlideIndex;
        this.deck.versionIndex = index;
        this.deck.deckEpoch++;   // restoring swaps the whole deck — invalidate stale thumbnails
        // Restoring a version is a whole-deck swap. Selection paths that
        // resolved against the previous version may not exist (or may
        // resolve to different content) in the restored one. Clear it.
        this.editScope.clear();
        this.deck.phase = 'preview-ready';
        // Consistency: a version swap is a deck mutation — refresh the canvas
        // (refreshPreview re-rasterizes the filmstrip against the bumped epoch so
        // thumbnails reflect the restored deck, not the cached newer one) + nav.
        this.canvas.refreshPreview();
        this.refreshVersionNav();
    }

    /** Re-render the version nav in its stable host (counter + button states).
     *  Called on mount and after every restoreVersion so the UI tracks state. */
    private refreshVersionNav(): void {
        if (!this.versionNavHost) return;
        this.versionNavHost.empty();
        if (this.deck.versions.length > 1) this.renderVersionNav(this.versionNavHost);
    }

    private renderVersionNav(container: HTMLElement): void {
        const nav = container.createEl('div', { cls: 'ai-organiser-pres-version-nav' });

        const prevBtn = nav.createEl('button', { cls: 'ai-organiser-pres-version-btn', text: '◄ prev' });
        prevBtn.disabled = this.deck.versionIndex <= 0;
        prevBtn.addEventListener('click', () => this.restoreVersion(this.deck.versionIndex - 1));

        nav.createEl('span', {
            cls: 'ai-organiser-pres-version-counter',
            text: `v${this.deck.versionIndex + 1}/${this.deck.versions.length}`,
        });

        const nextBtn = nav.createEl('button', { cls: 'ai-organiser-pres-version-btn', text: 'Next ►' });
        nextBtn.disabled = this.deck.versionIndex >= this.deck.versions.length - 1;
        nextBtn.addEventListener('click', () => this.restoreVersion(this.deck.versionIndex + 1));
    }

    // ── Brand Toggle ────────────────────────────────────────────────────────

    private renderBrandToggle(container: HTMLElement, ctx: ModalContext): void {
        const toggle = container.createEl('div', { cls: 'ai-organiser-pres-brand-toggle' });

        if (this.brandAvailable) {
            // Brand file exists — show functional toggle
            const label = toggle.createEl('label', { cls: 'ai-organiser-pres-brand-label' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.brandEnabled;
            this.brandCheckboxEl = checkbox;
            // F7: toggling On-brand re-renders the live deck (preserving version +
            // active slide). handleBrandToggle is fully contained (never rejects),
            // so the listener can `void` it.
            checkbox.addEventListener('change', () => {
                void this.handleBrandToggle(ctx, checkbox.checked);
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

    // ── Deck commit + brand re-render + busy guard (presentation-demo-fixes) ──

    /**
     * Shared deck-commit CORE transaction (used by generateIr + buildFromStorylineNote).
     * Sets the new deck IR + HTML, resets the active slide, refreshes the preview,
     * pushes a version (which bumps `deckEpoch`), records the brand state the HTML was
     * built with, and updates reliability. Callers run their own tail (brand audit /
     * quality-scan ctx) because those differ between generation and storyline rebuild.
     * `renderedBrandEnabled` MUST be the value captured BEFORE the async theme-resolve
     * that produced `builtHtml` (Gemini-G1), so `lastRenderedBrandEnabled` always
     * matches the deck actually rendered.
     */
    private commitNewDeck(input: { ir: SlideDeckIr; builtHtml: string; label: string; renderedBrandEnabled: boolean }): void {
        this.deck.deckIr = input.ir;
        this.deck.html = input.builtHtml;
        this.deck.activeSlideIndex = 0;
        this.canvas.refreshPreview();
        this.deck.pushVersion(input.label);   // bumps deckEpoch
        this.lastRenderedBrandEnabled = input.renderedBrandEnabled;
        this.updateReliability();
    }

    /** F4 — shared busy guard: notify + return false when a mutating op holds the
     *  lock, so Polish / Check-Brand report busy consistently with export/save. */
    private assertNotBusy(ctx: ModalContext, callbacks: ActionCallbacks): boolean {
        if (this.run.isLocked()) {
            callbacks.notify(ctx.plugin.t.modals.unifiedChat.presentationBusy);
            return false;
        }
        return true;
    }

    /** F7 — user toggled On-brand: update intent, drop the cached theme, re-render
     *  the live deck. Contained (never rejects) so the change listener can `void` it. */
    private async handleBrandToggle(ctx: ModalContext, checked: boolean): Promise<void> {
        this.brandEnabled = checked;
        this.brandTheme = null;
        await this.executeBrandRerender(ctx, checked);
    }

    /** Contained wrapper around the scheduler that applies the failure policy on
     *  EVERY render path (toggle / flush / drain) — never rejects (Gemini/R3-H2). */
    private async executeBrandRerender(ctx: ModalContext, brandEnabled: boolean): Promise<void> {
        let outcome: 'applied' | 'queued' | 'skipped-no-deck' | 'error' = 'error';
        try {
            outcome = await this.requestBrandRerender(ctx, brandEnabled);
        } catch (e) {
            logger.warn('Presentation', `brand re-render threw: ${e instanceof Error ? e.message : String(e)}`);
            outcome = 'error';
        }
        if (outcome === 'error') this.applyBrandFailurePolicy(ctx);
    }

    /**
     * F7 scheduler — monotonic last-write-wins brand re-render of the CURRENT deck.
     * Bumps `brandReqId` on every request (incl. queued) so a stale in-flight render
     * can never commit; queues (latest-wins) while a mutating op holds the lock or a
     * render is in flight; preserves the active slide. Pure scheduler — never shows a
     * Notice (that's `applyBrandFailurePolicy`, via `executeBrandRerender`).
     */
    private async requestBrandRerender(ctx: ModalContext, brandEnabled: boolean): Promise<'applied' | 'queued' | 'skipped-no-deck' | 'error'> {
        const reqId = ++this.brandReqId;
        // Queue-first (R3-H1): record intent before the no-deck check so a toggle
        // during the FIRST generation (no deck yet) is honoured on release.
        if (this.run.isLocked() || this.brandRendering) {
            this.pendingBrand = { brandEnabled, reqId };
            return 'queued';
        }
        if (!this.deck.deckIr) return 'skipped-no-deck';
        this.brandRendering = true;
        const prevSlide = this.deck.activeSlideIndex;
        try {
            const exportTheme = await this.themeResolver.resolve(ctx, brandEnabled);
            const themeCss = (await resolveTheme(ctx.app, ctx.plugin.settings, brandEnabled)).css;
            // Staleness gate: a newer toggle superseded us while resolving.
            if (reqId !== this.brandReqId) return 'queued';
            const built = buildHtmlFromDeckIr(
                this.deck.deckIr, exportTheme, themeCss,
                ctx.plugin.settings.summaryLanguage,
                ctx.plugin.t.progress.presentation.slideRenderFailed,
            );
            if (!built.ok) {
                logger.warn('Presentation', `brand re-render html failed: ${built.error}`);
                return 'error';
            }
            this.deck.html = built.value;
            this.deck.deckEpoch++;   // re-theme (no version push) — invalidate thumbnails
            const count = countSlides(built.value);
            this.deck.activeSlideIndex = Math.min(prevSlide, Math.max(0, count - 1));
            this.canvas.refreshPreview();
            this.lastRenderedBrandEnabled = brandEnabled;
            return 'applied';
        } finally {
            this.brandRendering = false;
            // Drain the latest queued state (older queued states were overwritten).
            if (this.pendingBrand && !this.run.isLocked()) {
                const p = this.pendingBrand;
                this.pendingBrand = null;
                void this.executeBrandRerender(ctx, p.brandEnabled);
            }
        }
    }

    /** Reconcile UI + notify when a brand re-render fails on ANY path — works
     *  without a closure because the checkbox ref + baseline are handler state. */
    private applyBrandFailurePolicy(ctx: ModalContext): void {
        new Notice(ctx.plugin.t.modals.unifiedChat.brandRerenderFailed);
        this.brandEnabled = this.lastRenderedBrandEnabled;
        if (this.brandCheckboxEl) this.brandCheckboxEl.checked = this.lastRenderedBrandEnabled;
    }

    /** Flush a brand re-render queued while a mutating op held the lock. Wired to
     *  the run controller's release hook (fires after end()/unlock()). */
    private flushPendingBrandRerender(): void {
        if (!this.pendingBrand || this.run.isLocked() || !this.lastCtx) return;
        const p = this.pendingBrand;
        this.pendingBrand = null;
        void this.executeBrandRerender(this.lastCtx, p.brandEnabled);
    }

    /**
     * B3 — rebuild a deck from a SAVED consultant storyline note, decoupled from
     * the in-memory `pendingStoryline` gate (so it survives a modal close / reload /
     * mode switch). `buildDeckFromStoryline` is deterministic (no LLM) so this is
     * fast. Fully exception-contained — never rejects; the caller (the modal) `void`s
     * it and re-renders. The empty catalog means grounding is advisory (the `⚠`
     * checks were authored into the `.md`). The modal calls `renderAll()` afterwards
     * to mount the canvas with the new deck.
     */
    async buildFromStorylineNote(ctx: ModalContext, notePath: string): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat;
        try {
            if (this.run.isLocked()) { new Notice(t.presentationBusy); return; }
            const file = ctx.app.vault.getAbstractFileByPath(notePath);
            if (!(file instanceof TFile)) { new Notice(t.storylineNoteRequired); return; }
            const md = await ctx.app.vault.read(file);
            const cls = classifyStorylineNote(md);
            if (cls.kind === 'empty') { new Notice(t.storylineNoteEmpty); return; }
            if (cls.kind !== 'ok') { new Notice(t.storylineNoteRequired); return; }

            this.run.begin(() => { /* deterministic build — no thinking sink needed */ }, t);
            try {
                // Capture brand BEFORE the async theme-resolve (Gemini-G1).
                const requestedBrand = this.brandEnabled;
                const built = buildDeckFromStoryline(md, [], ctx.plugin.settings.summaryLanguage);
                if (!built.ok) { new Notice(t.storylineParseFailed.replace('{error}', built.error)); return; }
                const exportTheme = await this.themeResolver.resolve(ctx, requestedBrand);
                const themeCss = (await resolveTheme(ctx.app, ctx.plugin.settings, requestedBrand)).css;
                const html = buildHtmlFromDeckIr(
                    built.value.deck, exportTheme, themeCss,
                    ctx.plugin.settings.summaryLanguage,
                    ctx.plugin.t.progress.presentation.slideRenderFailed,
                );
                if (!html.ok) { new Notice(t.storylineParseFailed.replace('{error}', html.error)); return; }
                this.commitNewDeck({ ir: built.value.deck, builtHtml: html.value, label: file.basename, renderedBrandEnabled: requestedBrand });
                this.pendingStoryline = null;   // Gemini-G2: resync the live chat gate
                this.runQualityCheck();
                this.setPhase('preview-ready');
                void this.runBackgroundQualityScan(this.getLLMContext(ctx), this.run.signal ?? new AbortController().signal);
                new Notice(t.storylineRebuiltFromSavedNote);
            } finally {
                this.run.end();
                this.flushPendingBrandRerender();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Presentation', `[build-from-storyline] threw: ${msg}`);
            new Notice(t.buildFromStorylineFailed.replace('{error}', msg));
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
        this.run.abort();
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
        if (!this.deck.html || !this.canvas.isReady()) return;
        const result = sanitizePresentation(this.deck.html);
        const tier = classifyReliability({
            rejectionCount: result.rejectionCount,
            hasDeckRoot: result.hasDeckRoot,
            hasSlides: result.hasSlides,
        });
        this.canvas.setReliability(tier);
    }

    private async runBackgroundQualityScan(ctx: LLMFacadeContext, signal: AbortSignal): Promise<void> {
        if (!this.deck.html) return;
        const slideCount = countSlides(this.deck.html);

        const fastResult = await runFastScan(ctx, this.deck.html, slideCount, signal);
        if (signal.aborted || !fastResult.ok) return;

        // Merge with existing deterministic findings
        const merged = deduplicateFindings(
            this.deck.qualityResult?.findings ?? [],
            fastResult.value.findings
        );
        if (this.deck.qualityResult) {
            this.deck.qualityResult = { ...this.deck.qualityResult, findings: merged };
            this.canvas.setQuality(this.deck.qualityResult);
        }
    }

    private runQualityCheck(auditViolationCount = 0): void {
        if (!this.deck.html || !this.canvas.isReady()) {
            this.deck.qualityResult = null;
            return;
        }
        const doc = this.canvas.getIframeDocument();
        if (!doc) return;
        const slides = extractSlideInfo(doc);
        const findings = runStructureChecks(slides);
        this.deck.qualityResult = computeQualityScore(findings, auditViolationCount);
    }

}
