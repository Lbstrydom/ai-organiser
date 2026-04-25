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
    type RefineScopedOutcome,
    MAX_VERSIONS, extractSlideInfo, runStructureChecks, computeQualityScore,
    migratePresentationSession, classifyReliability,
} from '../../services/chat/presentationTypes';
import { generateHtmlStream, refineHtml, runBrandAudit, refineHtmlScoped } from '../../services/chat/presentationHtmlService';
import { projectForEditor } from '../../services/chat/presentationDomDecorator';
import { DefaultSlideContextProvider } from '../../services/chat/slideContextProvider';
import { ResearchSearchService } from '../../services/research/researchSearchService';
import { ensurePrivacyConsent } from '../../services/privacyNotice';
import { SlideDiffModal } from '../modals/SlideDiffModal';
import { runFastScan, deduplicateFindings } from '../../services/chat/presentationQualityService';
import { sanitizePresentation } from '../../services/chat/presentationSanitizer';
import { LongRunningOpController } from '../../services/longRunningOp/progressController';
import { parseExpectedSlideCount } from '../../services/chat/generationProgressController';
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

    // Active SlideDiffModal — tracked so cancelActiveOperation / onClear /
    // dispose can force-close it. Otherwise the user could Discard the deck
    // while the diff modal is awaiting their click, then Accept the modal
    // and silently resurrect the discarded HTML. Audit R1 finding (HIGH-2).
    private activeDiffModal: SlideDiffModal | null = null;

    // Translations stashed when renderContextPanel runs — refreshAccessory
    // reads from here. Stays alive between renders; nulled in dispose.
    private accessoryT: Translations['modals']['unifiedChat'] | null = null;

    // ── Phase progress ──────────────────────────────────────────────────────

    /** Centralized phase setter that bubbles a phase-specific message to the
     *  chat "Thinking…" placeholder when an async action is active. */
    private setPhase(phase: PresentationPhase): void {
        this.phase = phase;
        const label = this.getPhaseMessage(phase);
        if (label && this.activeThinkingUpdater) {
            this.activeThinkingUpdater(label);
        }
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

        container.empty();

        // Check brand availability
        this.brandAvailable = isBrandAvailable(ctx.app, ctx.plugin.settings);

        // Brand toggle — always shown, disabled with instructions if no file
        this.renderBrandToggle(container, ctx);

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
            });
            // Project canonical HTML for the editor: adds data-element
            // attributes the iframe runtime walks on click. Canonical HTML
            // (no data-element) stays in this.html for prompts/exports.
            this.preview.setHtml(projectForEditor(this.html));
            if (this.activeSlideIndex > 0) {
                // F5: track the navigate handle so rapid re-render / dispose
                // can cancel the stale callback before it fires.
                this.navigateTimeoutId = setTimeout(() => {
                    this.navigateTimeoutId = null;
                    this.preview?.navigateToSlide(this.activeSlideIndex);
                }, 200);
            }
            if (this.qualityResult) {
                this.preview.setQuality(this.qualityResult);
            }
        }

        // Version navigation
        if (this.versions.length > 1) {
            this.renderVersionNav(container);
        }

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
        const t = r.ctx.plugin.t.modals.unifiedChat;

        const expected = parseExpectedSlideCount(r.effectiveQuery);
        const controller = this.createProgressController(
            r.abort, r.streamCb, t,
            GENERATION_SOFT_BUDGET_MS, GENERATION_HARD_BUDGET_MS, expected,
        );

        // Initial label before first checkpoint
        this.renderProgress(r.streamCb, t, 0, expected, 0);

        // Visual elapsed-time ticker (aria-hidden) — updates every 1s. Live
        // region stays silent until slide count actually changes (see
        // updateProgressSplit contract in ChatModeHandler).
        const elapsedTimer = this.startElapsedTicker(controller, r.streamCb, t, expected);

        try {
            const result = await generateHtmlStream(r.llmCtx, {
                userQuery: r.effectiveQuery,
                noteContent: r.noteContent,
                conversationHistory: r.history,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                theme: r.theme,
                signal: r.abort.signal,
                onCheckpoint: (checkpoint) => {
                    if (r.abort.signal.aborted) return;
                    if (this.preview) this.preview.setHtml(projectForEditor(checkpoint.html));
                    controller.recordProgress(checkpoint.slideCount);
                },
            });

            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };

            if (!result.ok) {
                this.setPhase('error');
                this.lastError = result.error;
                return { finalContent: `Failed to generate: ${result.error}` };
            }

            this.html = result.value;
            this.activeSlideIndex = 0;
            this.pushVersion(r.originalQuery);
            this.updateReliability();

            if (this.brandEnabled && r.theme.auditChecklist.length > 0) {
                this.setPhase('auditing');
                await this.runAudit(r.llmCtx, r.theme, r.abort.signal);
            }

            this.runQualityCheck();
            this.setPhase('preview-ready');
            void this.runBackgroundQualityScan(r.llmCtx, r.abort.signal);

            const title = extractDeckTitle(this.html);
            const count = countSlides(this.html);
            return { finalContent: `Created "${title}" with ${count} slides. Describe changes to refine, or export when ready.` };
        } finally {
            globalThis.clearInterval(elapsedTimer);
            controller.dispose();
        }
    }

    private async runRefine(r: RunContext): Promise<StreamingResult> {
        this.setPhase('refining');
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.html) return { finalContent: 'No presentation to refine.' };

        const controller = this.createProgressController(
            r.abort, r.streamCb, t,
            REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS, undefined,
        );

        try {
            const result = await refineHtml(r.llmCtx, {
                currentHtml: this.html,
                userRequest: r.effectiveQuery,
                conversationHistory: r.history,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                theme: r.theme,
                signal: r.abort.signal,
            });

            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };

            if (!result.ok) {
                this.setPhase('error');
                this.lastError = result.error;
                return { finalContent: `Failed to refine: ${result.error}` };
            }

            this.html = result.value;
            this.pushVersion(r.originalQuery);
            this.runQualityCheck();
            // Whole-deck mutation invalidates positional selection paths
            // (slide-N.list-K.item-J may now resolve to a different element).
            // Plan §"State transitions" mandates clearing on every html mutation.
            this.clearSelection();
            this.setPhase('preview-ready');
            void this.runBackgroundQualityScan(r.llmCtx, r.abort.signal);

            const count = countSlides(this.html);
            return { finalContent: `Updated. ${count} slides. Continue refining or export.` };
        } finally {
            controller.dispose();
        }
    }

    /** Scoped (targeted) edit path — invoked when the user has clicked an
     *  element/slide in the iframe and submitted an edit instruction.
     *
     *  Differs from runRefine in three ways:
     *  - Calls `refineHtmlScoped` (sends scope + scoped fragment + full deck)
     *  - Web search / references resolved via `DefaultSlideContextProvider`
     *  - Result is gated through `SlideDiffModal` — user explicitly accepts
     *    before the iframe updates and a version is pushed.
     *
     *  Plan: docs/plans/slide-authoring-editing.md §"Submission contract"
     */
    private async runScopedEdit(
        r: RunContext,
        scope: SelectionScope,
        mode: EditMode,
        flags: EditFlags,
    ): Promise<StreamingResult> {
        this.setPhase('refining');
        const t = r.ctx.plugin.t.modals.unifiedChat;
        if (!this.html) return { finalContent: 'No presentation to edit.' };

        const controller = this.createProgressController(
            r.abort, r.streamCb, t,
            REFINEMENT_SOFT_BUDGET_MS, REFINEMENT_HARD_BUDGET_MS, undefined,
        );

        try {
            // Build a context provider that bridges to the vault + research
            // services. Privacy consent is gated lazily — only fired if web
            // search is actually requested (matches the existing per-feature
            // consent pattern; no consent burden when the user only wants
            // text-only edits).
            const contextProvider = new DefaultSlideContextProvider({
                app: r.ctx.app,
                researchService: new ResearchSearchService(r.ctx.fullPlugin),
                // Mirror ResearchModeHandler.ensureConsent: gate web-search
                // through the existing cloud-service-type consent path so we
                // share the "consented this session" flag instead of double-
                // prompting users who already approved cloud research.
                privacyConsent: async () => ensurePrivacyConsent(
                    { app: r.ctx.app, t: r.ctx.plugin.t },
                    r.ctx.fullPlugin.settings.cloudServiceType,
                ),
            });

            const result = await refineHtmlScoped(r.llmCtx, {
                currentHtml: this.html,
                scope,
                mode,
                userRequest: r.effectiveQuery,
                flags,
                contextProvider,
                conversationHistory: r.history,
                outputLanguage: r.ctx.plugin.settings.summaryLanguage,
                theme: r.theme,
                signal: r.abort.signal,
            });

            if (r.abort.signal.aborted) return { finalContent: t.generationCancelled };

            if (!result.ok) {
                this.setPhase('error');
                this.lastError = result.error;
                return { finalContent: `Failed to apply scoped edit: ${result.error}` };
            }

            // Gate the iframe update behind explicit user accept.
            const accepted = await this.confirmScopedEdit(r.ctx.app, r.ctx.fullPlugin, result.value);
            // If onClear / dispose ran during the modal wait, this.html is
            // null and the deck has been discarded. Don't force phase back
            // to 'preview-ready' over an empty deck — that would leave us
            // in (html=null, phase='preview-ready') which is inconsistent.
            // Audit R2 LOW finding fix.
            if (!this.html) return { finalContent: t.generationCancelled };
            if (!accepted) {
                this.setPhase('preview-ready');
                return { finalContent: 'Edit rejected — original deck preserved.' };
            }

            // Apply
            this.html = result.value.newHtml;
            this.pushVersion(r.originalQuery);
            this.runQualityCheck();
            this.clearSelection();
            this.setPhase('preview-ready');

            const count = countSlides(this.html);
            const driftCount = result.value.outOfScopeDrift.length;
            const driftPlural = driftCount === 1 ? '' : 's';
            const driftSuffix = driftCount > 0
                ? ` (note: ${driftCount} slide${driftPlural} drifted outside scope — accepted)`
                : '';
            return { finalContent: `Scoped edit applied. ${count} slides${driftSuffix}.` };
        } finally {
            controller.dispose();
        }
    }

    /** Open the SlideDiffModal and wait for the user to accept or reject.
     *  Resolves to true on accept, false on reject / ESC / X-close. */
    private confirmScopedEdit(
        app: import('obsidian').App,
        plugin: import('../../main').default,
        outcome: RefineScopedOutcome,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            // Single-flight resolution guard — a force-close from
            // cancelActiveOperation / onClear / dispose calls modal.close(),
            // which fires the Modal's onClose() → SlideDiffModal's reject
            // fallback. Without this guard, both that path AND a later
            // user-initiated Accept could resolve the same Promise.
            let resolved = false;
            const finish = (accepted: boolean) => {
                if (resolved) return;
                resolved = true;
                this.activeDiffModal = null;
                resolve(accepted);
            };
            const modal = new SlideDiffModal(app, plugin, {
                scopeDiff: outcome.scopeDiff,
                outOfScopeDrift: outcome.outOfScopeDrift,
                structuralIntegrity: outcome.structuralIntegrity,
                onAction: (action) => finish(action === 'accept'),
            });
            this.activeDiffModal = modal;
            modal.open();
        });
    }

    /** Force-close the active diff modal (if any) so its Promise resolves
     *  to false. Called from cancelActiveOperation / onClear / dispose so
     *  the user can't accept a diff after they've already discarded the
     *  underlying deck. Audit R1 HIGH-2 fix. */
    private closeActiveDiffModal(): void {
        if (!this.activeDiffModal) return;
        const m = this.activeDiffModal;
        this.activeDiffModal = null;
        m.close(); // triggers Modal.onClose → SlideDiffModal.reject fallback
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
        const actions: ActionDescriptor[] = [
            {
                id: 'export-html',
                labelKey: 'Save as HTML note',
                tooltipKey: 'Save as a self-contained HTML note — keep chatting to refine, then export when finished',
                isEnabled: hasDeck && ready && !locked,
                isDefault: true,
            },
            {
                id: 'export-pptx',
                labelKey: 'Export to PPTX',
                tooltipKey: 'Final export to editable PowerPoint file',
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
        this.clearNavigateTimeout();  // F5
        this.html = null;
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
    }

    dispose(): void {
        this.cancelActiveOperation();
        this.clearNavigateTimeout();  // F5
        this.preview?.dispose();
        this.preview = null;
        this.accessoryContainer = null;
        this.accessoryT = null;
        this.selection = null;
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
     *  alive during buildPrompt's start hook. */
    private refreshAccessory(): void {
        if (!this.accessoryContainer || !this.accessoryT) return;
        const t = this.accessoryT; // capture stable ref
        import('./presentation/EditAccessories').then(({ renderEditAccessories }) => {
            if (!this.accessoryContainer) return;
            renderEditAccessories(this.accessoryContainer, {
                selection: this.selection,
                editMode: this.editMode,
                editFlags: this.editFlags,
                operation: this.deriveOperation(),
                t,
                onClearSelection: () => this.clearSelection(),
                onSetMode: (m) => this.setEditMode(m),
                onSetWebSearch: (on) => this.setWebSearchFlag(on),
            });
        }).catch(() => { /* test env — ignore */ });
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
        // Phase 1B F8: replace silent returns with user-visible notices so
        // broken-state clicks don't look like the button is dead.
        if (!this.html) {
            callbacks.addSystemNotice('Can\'t export — no presentation generated yet.');
            return;
        }
        if (this.mutationLock) {
            callbacks.addSystemNotice('Can\'t export right now — generation / refinement in progress.');
            return;
        }
        if (!this.preview) {
            callbacks.addSystemNotice('Preview not ready — click into the slide panel once, then retry export.');
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

            callbacks.addSystemNotice('PPTX exported — check your downloads folder.');
            new Notice('Pptx exported');
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.addSystemNotice(`PPTX export failed: ${msg}`);
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
        deckTitle: string,
    ): Promise<ArrayBuffer | null> {
        if (!this.html) return null;
        try {
            const { generatePptxFromHtml, resolveTheme } = await import('../../services/export/markdownPptxGenerator');
            const s = ctx.fullPlugin.settings;
            const theme = resolveTheme(
                s.exportColorScheme,
                s.exportPrimaryColor,
                s.exportAccentColor,
                s.exportFontFace,
                s.exportFontSize,
            );
            return await generatePptxFromHtml(this.html, theme, deckTitle);
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
            callbacks.addSystemNotice('Can\'t save — no presentation generated yet.');
            return;
        }
        if (this.mutationLock) {
            callbacks.addSystemNotice('Can\'t save right now — generation / refinement in progress.');
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
            callbacks.addSystemNotice(`Saved to ${path}`);
            new Notice(`Saved: ${path}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            callbacks.addSystemNotice(`HTML export failed: ${msg}`);
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
                callbacks.addSystemNotice(
                    `Brand audit: ${result.value.violations.length} fix(es) applied.`
                );
            } else if (result.ok) {
                callbacks.addSystemNotice('Brand audit: all checks passed.');
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
            const maxPasses = ctx.plugin.settings.aichatRefinementPasses || 1;

            for (let pass = 0; pass < maxPasses; pass++) {
                if (abort.signal.aborted) break;

                this.runQualityCheck();
                if (this.qualityResult && this.qualityResult.totalScore >= 80 && pass > 0) break;

                const findings = this.qualityResult?.findings || [];
                if (findings.length === 0) break;

                // Per-pass progress label (e.g. "Polish pass 2 of 3 — applying fixes…")
                this.activeThinkingUpdater?.(
                    `Polish pass ${pass + 1} of ${maxPasses} — applying fixes…`
                );

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

            if (this.brandEnabled && theme.auditChecklist.length > 0 && !abort.signal.aborted) {
                this.setPhase('auditing');
                await this.runAudit(llmCtx, theme, abort.signal);
            }

            this.runQualityCheck();
            // Whole-deck mutation invalidates positional selection paths.
            // Plan §"State transitions" mandates clearing on every html mutation.
            this.clearSelection();
            this.setPhase('preview-ready');
            callbacks.addSystemNotice(
                `Polish complete. Quality: ${this.qualityResult?.totalScore ?? '?'}/100`
            );
        } catch (e) {
            if (!abort.signal.aborted) {
                this.setPhase('error');
                this.lastError = e instanceof Error ? e.message : 'Polish failed';
                callbacks.addSystemNotice(`Polish failed: ${this.lastError}`);
            }
        } finally {
            this.mutationLock = false;
            this.activeThinkingUpdater = null;
            this.activeT = null;
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
        // Restoring a version is a whole-deck swap. Selection paths that
        // resolved against the previous version may not exist (or may
        // resolve to different content) in the restored one. Clear it.
        this.clearSelection();
        this.phase = 'preview-ready';
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
        // Force-close any pending diff modal so its Promise resolves to
        // false BEFORE the cancelling code path nulls handler state.
        // Otherwise an Accept click on the lingering modal would mutate
        // disposed state. Audit R1 HIGH-2 fix.
        this.closeActiveDiffModal();
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
