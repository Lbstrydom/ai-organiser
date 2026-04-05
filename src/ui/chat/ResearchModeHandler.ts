/**
 * Research Mode Handler
 *
 * UI-only handler. Delegates all business logic to ResearchOrchestrator.
 * Follows ChatModeHandler interface with directResponse pattern (AD-1)
 * and handler-owned actions (AD-2).
 *
 * Phase 3 additions: budget UI, quality badges, academic toggle,
 * multi-perspective, vault pre-check, Zotero/save-findings actions.
 */

import { Platform, ButtonComponent, TFile } from 'obsidian';
import type { ChatModeHandler, ModalContext, SendResult, ActionDescriptor, ActionCallbacks } from './ChatModeHandler';
import type { Translations } from '../../i18n/types';
import { ResearchOrchestrator, type EscalationConsentFn } from '../../services/research/researchOrchestrator';
import { ResearchSearchService } from '../../services/research/researchSearchService';
import { ResearchUsageService } from '../../services/research/researchUsageService';
import { SourceQualityService } from '../../services/research/sourceQualityService';
import { ZoteroBridgeService } from '../../services/research/zoteroBridgeService';
import type {
    ResearchPhase, SearchResult, SiteScope, SearchProviderType,
    SourceMetadata, PerspectiveQuery,
} from '../../services/research/researchTypes';
import { PERSPECTIVE_PRESETS } from '../../services/prompts/researchPrompts';
import { ensurePrivacyConsent } from '../../services/privacyNotice';
import { ensureNoteStructureIfEnabled } from '../../utils/noteStructure';
import { appendAsNewSections } from '../../utils/editorUtils';
import { normalizeUrl } from '../../utils/urlUtils';
import { splitIntoBlocks } from '../../utils/highlightExtractor';
import { getResearchOutputFullPath } from '../../core/settings';
import { ensureFolderExists } from '../../utils/minutesUtils';
import { FolderScopePickerModal } from '../modals/FolderScopePickerModal';
import type AIOrganiserPlugin from '../../main';

const PHASE_ORDER: ResearchPhase[] = ['idle', 'searching', 'continuing', 'reviewing', 'extracting', 'synthesizing', 'done'];

const HIGHLIGHT_EQUAL_RE = /==([^=][\s\S]*?)==/g;
const HIGHLIGHT_MARK_RE = /<mark\b[^>]*>([\s\S]*?)<\/mark>/gi;

/** Extract individual highlighted text spans from note content. */
function extractHighlightSpans(content: string): string[] {
    const blocks = splitIntoBlocks(content);
    const highlighted = blocks.filter(b => b.hasHighlight);
    const spans: string[] = [];
    for (const block of highlighted) {
        for (const match of block.text.matchAll(HIGHLIGHT_EQUAL_RE)) {
            const text = match[1].trim();
            if (text) spans.push(text);
        }
        for (const match of block.text.matchAll(HIGHLIGHT_MARK_RE)) {
            const text = match[1].trim();
            if (text) spans.push(text);
        }
    }
    return spans;
}

export class ResearchModeHandler implements ChatModeHandler {
    readonly mode = 'research' as const;

    // Business logic
    private orchestrator: ResearchOrchestrator;
    private searchService: ResearchSearchService;
    private usageService: ResearchUsageService;
    private qualityService: SourceQualityService;
    private zoteroBridge: ZoteroBridgeService;

    // UI state
    private phase: ResearchPhase = 'idle';
    private searchResults: SearchResult[] = [];
    private selectedUrls: string[] = [];
    private sourceSummaries: Record<string, string> = {};
    private lastSynthesis: string | null = null;
    private lastQuestion: string = '';
    private siteScope: SiteScope = 'all';
    private dateRange: import('../../services/research/researchTypes').SearchOptions['dateRange'] = 'any';
    private isProcessing = false;
    private forceNewSearch = false;  // Set by "Search Again" to bypass contextual answer

    // Phase 3: additional UI state
    private academicMode = false;
    private perspectiveMode = false;
    private sourceMetadata: SourceMetadata[] = [];
    private streamAbortController: AbortController | null = null;
    private currentSearchQuery: string | null = null;
    private skipVaultPrecheck = false;
    private pendingPrecheckQuery: string | null = null;
    private pendingPrecheckResult: import('../../services/research/researchTypes').VaultPrecheckResult | null = null;

    // Phase 3.4: Multi-turn conversation history for Claude Web Search
    private conversationHistory: Array<{ role: string; content: unknown }> = [];

    // Collapsible results: tracks user manual expand in done phase
    private resultsManuallyExpanded = false;

    // DOM references (VaultModeHandler pattern)
    private contextPanelContainer: HTMLElement | null = null;
    private lastCtx: ModalContext | null = null;
    private consentGiven = false;
    private sessionCleared = false;

    /** Callback to fill the modal's input textarea (set by modal). */
    private onFillInput?: (text: string) => void;

    setFillInputCallback(cb: (text: string) => void): void {
        this.onFillInput = cb;
    }

    constructor(private plugin: AIOrganiserPlugin) {
        this.searchService = new ResearchSearchService(plugin);
        this.usageService = new ResearchUsageService(plugin.app, plugin.settings);
        this.qualityService = new SourceQualityService();
        this.zoteroBridge = new ZoteroBridgeService();
        this.orchestrator = new ResearchOrchestrator(this.searchService, plugin, {
            usageService: this.usageService,
            qualityService: this.qualityService,
        });

        // Load initial toggle states from settings
        this.perspectiveMode = plugin.settings.enableResearchPerspectiveQueries;
    }

    /** Centralized phase setter — resets manual expand state on every transition. */
    private setPhase(phase: ResearchPhase): void {
        this.phase = phase;
        this.resultsManuallyExpanded = false;
    }

    isAvailable(_ctx: ModalContext): boolean {
        // Always visible for discoverability; unavailable message shown if no provider configured
        return true;
    }

    unavailableReason(t: Translations): string {
        return (t.modals.unifiedChat as Record<string, string>).researchUnavailable || 'Configure a search provider in Settings → Research Assistant';
    }

    getIntroMessage(t: Translations): string {
        return (t.modals.unifiedChat as Record<string, string>).introResearch || 'What would you like to research? I\'ll search the web and help you find relevant sources.';
    }

    getPlaceholder(t: Translations): string {
        return (t.modals.unifiedChat as Record<string, string>).placeholderResearch || 'Describe what you\'re looking for...';
    }

    renderContextPanel(container: HTMLElement, ctx: ModalContext): void {
        this.contextPanelContainer = container;
        this.lastCtx = ctx;

        // Inner wrapper prevents CSS leak to other chat modes (Note/Vault/Highlight)
        // which share the same contextEl DOM node
        const wrapper = container.createEl('div', { cls: 'ai-organiser-research-context' });

        // Phase 3: Budget warning banner (if applicable)
        this.renderBudgetBanner(wrapper, ctx);

        // 1. Controls row: scope, academic toggle, perspective toggle
        this.renderControlsRow(wrapper, ctx);

        // 1b. Note highlights picker (idle phase only)
        if (this.phase === 'idle' && ctx.options.noteContent) {
            this.renderHighlightPicker(wrapper, ctx);
        }

        // 2. Phase stepper
        this.renderPhaseStepper(wrapper);

        // 3. Result cards (only when results exist) — collapsible in done phase
        if (this.searchResults.length > 0) {
            this.renderResultsSection(wrapper, ctx);
        }

        // Phase 3: Usage footer
        this.renderUsageFooter(wrapper);
    }

    async buildPrompt(query: string, _history: string, ctx: ModalContext): Promise<SendResult> {
        // Privacy consent on first message (AD-8)
        if (!this.consentGiven) {
            const consent = await this.ensureConsent(ctx);
            if (consent) return consent;
        }

        // Ensure usage service is loaded
        await this.usageService.ensureLoaded();

        // Check for resumable session on first query
        const resumed = await this.tryResumeSession(ctx);
        if (resumed) return resumed;

        const language = ctx.fullPlugin.settings.summaryLanguage;

        // Phase 3: Vault pre-check (AD-15) — interactive 3-button UX
        if (this.phase === 'idle' && !this.skipVaultPrecheck
            && ctx.fullPlugin.settings.enableResearchVaultPrecheck
            && ctx.semanticSearchEnabled) {
            const precheck = await this.orchestrator.precheckVaultContext(
                query,
                ctx.options.noteContent ? ctx.app.workspace.getActiveFile() ?? undefined : undefined,
            );
            if (precheck && precheck.relatedNotes.length > 0) {
                const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
                const noteList = precheck.relatedNotes
                    .map(n => `- **${n.path}** (${Math.round(n.similarity * 100)}%) — ${n.excerpt}`)
                    .join('\n');
                const msg = (t.researchVaultPrecheckFound || 'I found {count} related notes in your vault:')
                    .replace('{count}', String(precheck.relatedNotes.length));
                // Store for action handlers
                this.pendingPrecheckQuery = query;
                this.pendingPrecheckResult = precheck;
                return {
                    prompt: '',
                    directResponse: `${msg}\n\n${noteList}`,
                };
            }
        }

        // AD-5: In reviewing phase, try to answer from existing snippets first
        // "Search Again" sets forceNewSearch to bypass this check
        if (this.phase === 'reviewing' && this.searchResults.length > 0 && !this.forceNewSearch) {
            const contextAnswer = await this.orchestrator.tryAnswerFromContext(query, this.searchResults, language);
            if (contextAnswer) return { prompt: '', directResponse: contextAnswer };
            // Contextual answer failed — fall through to new search
        }
        this.forceNewSearch = false;

        // Reset stale state for new search cycle
        this.lastSynthesis = null;
        this.sourceMetadata = [];
        return this.executeSearchCycle(query, ctx, language);
    }

    private async ensureConsent(ctx: ModalContext): Promise<SendResult | null> {
        const consented = await ensurePrivacyConsent(
            { app: ctx.app, t: ctx.plugin.t },
            ctx.fullPlugin.settings.cloudServiceType,
        );
        if (!consented) {
            return { prompt: '', systemNotice: 'Privacy consent required for cloud research.' };
        }
        this.consentGiven = true;
        return null;
    }

    private async tryResumeSession(ctx: ModalContext): Promise<SendResult | null> {
        if (this.phase !== 'idle' || this.searchResults.length > 0) return null;
        const session = await this.orchestrator.findResumableSession();
        if (!session) return null;

        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        this.searchResults = session.searchResults;
        this.selectedUrls = session.selectedUrls;
        this.sourceSummaries = session.sourceSummaries;
        this.lastSynthesis = session.synthesis ?? null;
        this.lastQuestion = session.question;
        this.siteScope = session.siteScope;
        this.dateRange = session.dateRange ?? 'any';
        this.academicMode = session.academicMode ?? false;
        this.perspectiveMode = session.perspectiveMode ?? this.perspectiveMode;
        this.sourceMetadata = session.sourceMetadata ?? [];
        this.conversationHistory = session.conversationHistory ?? [];
        this.setPhase(session.phase === 'done' ? 'done' : 'reviewing');
        this.rerenderContextPanel();
        return {
            prompt: '',
            directResponse: (t.resumeSession || 'Resume your previous research on "{question}"?')
                .replace('{question}', session.question),
        };
    }

    private async executeSearchCycle(query: string, ctx: ModalContext, language?: string): Promise<SendResult> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        this.setPhase('searching');
        this.rerenderContextPanel();
        this.lastQuestion = query;

        try {
            const noteContext = ctx.options.noteContent?.slice(0, 2000);
            const preferredSites = this.parseSiteList(ctx.fullPlugin.settings.researchPreferredSites);

            // Claude Web Search: unified pipeline (AD-1, AD-3)
            if (ctx.fullPlugin.settings.researchProvider === 'claude-web-search') {
                return this.executeClaudeWebSearchCycle(query, ctx, language);
            }

            // Phase 3: pass academic and perspective options to decomposition
            const queries = await this.orchestrator.decomposeQuestion(
                query, noteContext, preferredSites, language,
                {
                    academicMode: this.academicMode,
                    perspectiveMode: this.perspectiveMode,
                    perspectivePreset: ctx.fullPlugin.settings.researchPerspectivePreset,
                    customPerspectives: ctx.fullPlugin.settings.researchCustomPerspectives,
                },
            );

            // Extract plain query strings for search (handle PerspectiveQuery[] or string[])
            const queryStrings = queries.map(q =>
                typeof q === 'string' ? q : (q).query,
            );

            const results = await this.orchestrator.executeSearch(queryStrings, {
                siteScope: this.siteScope,
                dateRange: this.dateRange,
                preferredSites,
                excludedSites: this.parseSiteList(ctx.fullPlugin.settings.researchExcludedSites),
                academicMode: this.academicMode,
            });

            // Check if a fallback provider was used (Fix 14)
            const fallbackUsed = this.searchService.fallbackProviderUsed;
            let fallbackNotice: string | undefined;
            if (fallbackUsed) {
                const PROVIDER_LABELS: Record<string, string> = {
                    'tavily': 'Tavily', 'brightdata-serp': 'Bright Data', 'claude-web-search': 'Claude Web Search',
                };
                fallbackNotice = (t.researchProviderFallback || 'Primary provider returned no results — used {provider} instead')
                    .replace('{provider}', PROVIDER_LABELS[fallbackUsed] || fallbackUsed);
            }

            if (results.length === 0) {
                this.setPhase(this.searchResults.length > 0 ? 'reviewing' : 'idle');
                this.rerenderContextPanel();
                return { prompt: '', directResponse: t.noResults || 'No results found. Try rephrasing your question.' };
            }

            // Phase 3: enrich academic metadata on results
            if (this.academicMode) {
                this.orchestrator.enrichAcademicMetadata(results);
            }

            // Phase 3: attach perspective labels to results
            if (this.perspectiveMode && queries.length > 0 && typeof queries[0] !== 'string') {
                const perspectiveQueries = queries as PerspectiveQuery[];
                for (const result of results) {
                    if (result.perspective) continue; // Already labeled
                    // Match result to perspective by checking which query's terms best match
                    for (const pq of perspectiveQueries) {
                        const queryWords = pq.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                        const matchText = `${result.title} ${result.snippet}`.toLowerCase();
                        const matchCount = queryWords.filter(w => matchText.includes(w)).length;
                        if (matchCount >= Math.min(2, queryWords.length)) {
                            result.perspective = pq.perspective;
                            break;
                        }
                    }
                    // Fallback: assign first perspective if none matched
                    if (!result.perspective && perspectiveQueries.length > 0) {
                        result.perspective = perspectiveQueries[0].perspective;
                    }
                }
            }

            const { results: triaged, preSelectedUrls } = await this.orchestrator.triageResults(results, query, language);
            this.mergeResults(triaged);
            this.selectedUrls = [...new Set([...this.selectedUrls, ...preSelectedUrls])];
            this.setPhase('reviewing');
            this.rerenderContextPanel();

            // Phase 3: perspective summary
            let perspectiveNote = '';
            if (this.perspectiveMode && queries.length > 0 && typeof queries[0] !== 'string') {
                const perspectives = (queries as PerspectiveQuery[]).map(q => q.perspective);
                const unique = [...new Set(perspectives)];
                perspectiveNote = '\n' + (t.researchPerspectiveSummary || 'Searched from {count} perspectives: {perspectives}')
                    .replace('{count}', String(unique.length))
                    .replace('{perspectives}', unique.join(', '));
            }

            const summary = (t.foundResults || 'Found {count} results. I\'ve pre-selected the top {preselected} most relevant. Review the sources above and click **Read Selected** when ready.')
                .replace('{count}', String(this.searchResults.length))
                .replace('{preselected}', String(preSelectedUrls.length));
            return { prompt: '', directResponse: summary + perspectiveNote, systemNotice: fallbackNotice };
        } catch (error) {
            this.setPhase(this.searchResults.length > 0 ? 'reviewing' : 'idle');
            this.rerenderContextPanel();
            return { prompt: '', directResponse: `Search failed: ${(error as Error).message}` };
        }
    }

    /**
     * Unified search cycle for Claude Web Search (AD-1, AD-3).
     * Skips decompose/triage/extract phases — Claude handles all internally.
     * Phase 3: academic/perspective system prompt, multi-turn follow-ups.
     */
    private async executeClaudeWebSearchCycle(query: string, ctx: ModalContext, language?: string): Promise<SendResult> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;

        // Phase 3.2: resolve perspective names for system prompt
        let perspectives: string[] | undefined;
        if (this.perspectiveMode) {
            const preset = ctx.fullPlugin.settings.researchPerspectivePreset;
            if (preset === 'custom' && ctx.fullPlugin.settings.researchCustomPerspectives) {
                perspectives = ctx.fullPlugin.settings.researchCustomPerspectives.split(',').map(s => s.trim()).filter(Boolean);
            } else {
                perspectives = PERSPECTIVE_PRESETS[preset] || PERSPECTIVE_PRESETS.balanced;
            }
        }

        const searchOptions = {
            siteScope: this.siteScope,
            dateRange: this.dateRange,
            preferredSites: this.parseSiteList(ctx.fullPlugin.settings.researchPreferredSites),
            excludedSites: this.parseSiteList(ctx.fullPlugin.settings.researchExcludedSites),
            academicMode: this.academicMode,
            language,
            citationStyle: ctx.fullPlugin.settings.researchCitationStyle,
            perspectiveMode: this.perspectiveMode,
            perspectives,
        };

        // Phase 3.4: Multi-turn — use conversation history if available
        const isMultiTurn = this.conversationHistory.length > 0;

        // Streaming path — return streamingSetup so the modal can wire progressive updates
        if (ctx.fullPlugin.settings.enableResearchStreamingSynthesis) {
            return {
                prompt: '',
                streamingSetup: {
                    start: async (streamCb) => {
                        this.streamAbortController = new AbortController();
                        this.currentSearchQuery = null;
                        let accumulated = '';
                        const streamCallbacks = {
                            onSearchQuery: (q: string) => {
                                this.currentSearchQuery = q;
                                this.rerenderContextPanel();
                            },
                            onTextChunk: (text: string) => {
                                accumulated += text;
                                streamCb.updateMessage(accumulated);
                            },
                            onPhaseChange: (phase: string) => {
                                this.setPhase(phase as ResearchPhase);
                                this.rerenderContextPanel();
                            },
                        };
                        try {
                            let result;
                            if (isMultiTurn) {
                                const messages = [...this.conversationHistory, { role: 'user', content: query }];
                                result = await this.orchestrator.executeClaudeWebSearchMultiTurnStream(
                                    messages, searchOptions, streamCallbacks, this.streamAbortController.signal,
                                );
                            } else {
                                result = await this.orchestrator.executeClaudeWebSearchStream(
                                    query, searchOptions, streamCallbacks, this.streamAbortController.signal,
                                );
                            }
                            this.applyClaudeWebSearchResult(result);
                            this.updateConversationHistory(query, result.rawContent);
                            const searchNote = (t.claudeSearchCount || 'Claude performed {count} searches')
                                .replace('{count}', String(result.searchCount));
                            return { finalContent: `${result.synthesis}\n\n*${searchNote}*` };
                        } catch (error) {
                            this.setPhase('idle');
                            this.currentSearchQuery = null;
                            this.rerenderContextPanel();
                            return { finalContent: `Search failed: ${(error as Error).message}` };
                        } finally {
                            this.streamAbortController = null;
                        }
                    },
                },
            };
        }

        // Non-streaming path
        try {
            let result;
            if (isMultiTurn) {
                const messages = [...this.conversationHistory, { role: 'user', content: query }];
                result = await this.orchestrator.executeClaudeWebSearchMultiTurn(messages, searchOptions, {
                    onPhaseChange: (phase) => {
                        this.setPhase(phase as ResearchPhase);
                        this.rerenderContextPanel();
                    },
                });
            } else {
                result = await this.orchestrator.executeClaudeWebSearch(query, searchOptions, {
                    onPhaseChange: (phase) => {
                        this.setPhase(phase as ResearchPhase);
                        this.rerenderContextPanel();
                    },
                });
            }

            if (result.results.length === 0) {
                this.setPhase('idle');
                this.rerenderContextPanel();
                return { prompt: '', directResponse: t.noResults || 'No results found. Try rephrasing your question.' };
            }

            this.applyClaudeWebSearchResult(result);
            this.updateConversationHistory(query, result.rawContent);

            const searchNote = (t.claudeSearchCount || 'Claude performed {count} searches')
                .replace('{count}', String(result.searchCount));

            return { prompt: '', directResponse: `${result.synthesis}\n\n*${searchNote}*` };
        } catch (error) {
            this.setPhase('idle');
            this.rerenderContextPanel();
            return { prompt: '', directResponse: `Search failed: ${(error as Error).message}` };
        }
    }

    /** Append user question and assistant rawContent to conversation history for multi-turn. */
    private updateConversationHistory(question: string, rawContent: unknown[]): void {
        this.conversationHistory.push(
            { role: 'user', content: question },
            { role: 'assistant', content: rawContent },
        );
    }

    /** Apply search results to handler state (shared by streaming and non-streaming paths). */
    private applyClaudeWebSearchResult(result: {
        results: SearchResult[];
        synthesis: string;
        sourceMetadata: SourceMetadata[];
        rawContent?: unknown[];
    }): void {
        this.mergeResults(result.results);
        this.selectedUrls = result.results.map(r => r.url);
        this.lastSynthesis = result.synthesis;
        this.sourceMetadata = result.sourceMetadata;
        this.currentSearchQuery = null;
        this.setPhase('done');
        this.rerenderContextPanel();
    }

    getActionDescriptors(_t: Translations): ActionDescriptor[] {
        const descriptors: ActionDescriptor[] = [];

        // Phase 3: Vault pre-check choice buttons
        if (this.pendingPrecheckQuery) {
            descriptors.push(
                { id: 'vault-precheck-use', labelKey: 'researchVaultPrecheckUse', tooltipKey: 'researchVaultPrecheckUse', isEnabled: true, requiresEditor: false },
                { id: 'vault-precheck-continue', labelKey: 'researchVaultPrecheckContinue', tooltipKey: 'researchVaultPrecheckContinue', isEnabled: true, requiresEditor: false },
                { id: 'vault-precheck-always', labelKey: 'researchVaultPrecheckAlways', tooltipKey: 'researchVaultPrecheckAlways', isEnabled: true, requiresEditor: false },
            );
            return descriptors; // Only show precheck actions while pending
        }

        if (this.phase === 'reviewing') {
            descriptors.push({
                id: 'read-selected',
                labelKey: 'readSelected',
                tooltipKey: 'readSelectedTooltip',
                isEnabled: this.selectedUrls.length > 0 && !this.isProcessing,
                requiresEditor: false,
            });
        }

        if (this.phase === 'done' && !this.lastSynthesis) {
            descriptors.push({
                id: 'synthesize',
                labelKey: 'synthesizeFindings',
                tooltipKey: 'synthesizeFindingsTooltip',
                isEnabled: Object.keys(this.sourceSummaries).length > 0 && !this.isProcessing,
                requiresEditor: false,
            });
        }

        if (this.lastSynthesis) {
            const defaultOutput = this.plugin.settings.researchDefaultOutput || 'cursor';
            const outputMap: Record<string, string> = { cursor: 'insert-at-cursor', section: 'add-as-section', pending: 'save-to-pending' };
            const defaultId = outputMap[defaultOutput];
            descriptors.push(
                { id: 'insert-at-cursor', labelKey: 'insertResearch', tooltipKey: 'insertResearchTooltip', isEnabled: !this.isProcessing, requiresEditor: true, isDefault: 'insert-at-cursor' === defaultId },
                { id: 'add-as-section', labelKey: 'addResearchSection', tooltipKey: 'addResearchSectionTooltip', isEnabled: !this.isProcessing, requiresEditor: true, isDefault: 'add-as-section' === defaultId },
                { id: 'save-to-pending', labelKey: 'saveSourcesToPending', tooltipKey: 'saveSourcesToPendingTooltip', isEnabled: !this.isProcessing, requiresEditor: true, isDefault: 'save-to-pending' === defaultId },
            );

            // Phase 3: Save findings as note
            descriptors.push({
                id: 'save-findings',
                labelKey: 'researchSaveFindings',
                tooltipKey: 'researchSaveFindingsTooltip',
                isEnabled: !this.isProcessing,
                requiresEditor: false,
            });

            // Phase 3: Zotero/CSL-JSON export (desktop only, gated by setting + connector)
            if (!Platform.isMobile && this.sourceMetadata.length > 0
                && this.plugin.settings.enableResearchZoteroIntegration) {
                const zoteroAvailable = this.zoteroBridge.isAvailable(this.plugin.app);
                descriptors.push({
                    id: 'send-to-zotero',
                    labelKey: zoteroAvailable ? 'researchSendToZotero' : 'researchCopyCslJson',
                    tooltipKey: zoteroAvailable
                        ? 'researchSendToZotero'
                        : 'researchZoteroDisabledTooltip',
                    isEnabled: !this.isProcessing,
                    requiresEditor: false,
                });
            }
        }

        return descriptors;
    }

    async handleAction(actionId: string, ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            switch (actionId) {
                case 'vault-precheck-use': await this.actionVaultPrecheckUse(ctx, cb); break;
                case 'vault-precheck-continue': await this.actionVaultPrecheckContinue(ctx, cb); break;
                case 'vault-precheck-always': await this.actionVaultPrecheckAlways(ctx, cb); break;
                case 'read-selected': await this.actionReadSelected(ctx, cb); break;
                case 'synthesize': await this.actionSynthesize(ctx, cb); break;
                case 'insert-at-cursor': await this.actionInsertAtCursor(ctx, cb); break;
                case 'add-as-section': await this.actionAddAsSection(ctx, cb); break;
                case 'save-to-pending': this.actionSaveToPending(ctx, cb); break;
                case 'save-findings': this.actionSaveFindings(ctx, cb); break;
                case 'send-to-zotero': await this.actionSendToZotero(ctx, cb); break;
            }
        } finally {
            this.isProcessing = false;
            cb.rerenderActions();
        }
    }

    // Phase 3: Vault pre-check action handlers
    private async actionVaultPrecheckUse(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const precheck = this.pendingPrecheckResult;
        const query = this.pendingPrecheckQuery;
        this.pendingPrecheckQuery = null;
        this.pendingPrecheckResult = null;
        if (!precheck || !query) return;

        // Use vault context to answer the question via LLM
        cb.showThinking();
        try {
            const context = precheck.relatedNotes
                .map(n => `### ${n.path}\n${n.excerpt}`)
                .join('\n\n');
            const prompt = `Based on the following notes from my vault, answer this question: "${query}"\n\n${context}`;
            const { summarizeText, pluginContext } = await import('../../services/llmFacade');
            const response = await summarizeText(pluginContext(ctx.fullPlugin), prompt);
            if (response.success && response.content) {
                cb.addAssistantMessage(response.content);
            } else {
                cb.addAssistantMessage('Could not generate an answer from vault context. Try searching the web.');
            }
        } finally {
            cb.hideThinking();
            cb.rerenderActions();
        }
    }

    private async actionVaultPrecheckContinue(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const query = this.pendingPrecheckQuery;
        this.pendingPrecheckQuery = null;
        this.pendingPrecheckResult = null;
        if (!query) return;

        // Proceed with web search
        this.lastSynthesis = null;
        this.sourceMetadata = [];
        const result = await this.executeSearchCycle(query, ctx, ctx.fullPlugin.settings.summaryLanguage);
        if (result.directResponse) cb.addAssistantMessage(result.directResponse);
        if (result.systemNotice) cb.addSystemNotice(result.systemNotice);
        cb.rerenderActions();
    }

    private async actionVaultPrecheckAlways(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        this.skipVaultPrecheck = true;
        await this.actionVaultPrecheckContinue(ctx, cb);
    }

    private async actionReadSelected(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const language = ctx.fullPlugin.settings.summaryLanguage;
        this.setPhase('extracting');
        this.rerenderContextPanel();
        cb.showThinking();
        try {
            // Escalation consent callback — asks user before using paid Bright Data tiers
            const onEscalation: EscalationConsentFn = (url, tier) => {
                const title = this.searchResults.find(r => r.url === url)?.title || url;
                const msgKey = tier === 'web-unlocker' ? 'escalateWebUnlocker' : 'escalateScrapingBrowser';
                const message = (t[msgKey] || '{title} — needs deeper extraction.').replace('{title}', title);
                cb.addSystemNotice(message);
                // Auto-approve: the user already clicked "Read Selected" knowing paid tiers may be used.
                // The system notice informs them which tier is being used.
                return Promise.resolve(true);
            };

            const extractions = await this.orchestrator.extractSources(
                this.selectedUrls, this.searchResults, this.lastQuestion,
                (_cur, _total, url) => cb.addSystemNotice((t.readingSource || 'Reading {url}...').replace('{url}', url)),
                language,
                onEscalation,
            );
            for (const ext of extractions) {
                if (ext.error) {
                    cb.addSystemNotice((t.fetchFailed || 'Could not read {url} — skipped').replace('{url}', ext.url));
                } else {
                    this.sourceSummaries[ext.url] = ext.findings;
                    cb.addAssistantMessage(`**${ext.title}**\n${ext.findings}`);
                }
            }
            this.setPhase('done');
        } finally {
            cb.hideThinking();
            this.rerenderContextPanel();
            cb.rerenderActions();
        }
    }

    private async actionSynthesize(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const language = ctx.fullPlugin.settings.summaryLanguage;
        const includeCitations = ctx.fullPlugin.settings.researchIncludeCitations;
        const citationStyle = ctx.fullPlugin.settings.researchCitationStyle;
        this.setPhase('synthesizing');
        this.rerenderContextPanel();
        cb.showThinking();

        try {
            const successful = this.selectedUrls
                .filter(u => this.sourceSummaries[u])
                .map(u => ({
                    url: u,
                    title: this.searchResults.find(r => r.url === u)?.title || u,
                    findings: this.sourceSummaries[u],
                    extractionMethod: 'readability' as const,
                }));

            // Phase 3: Streaming synthesis (AD-16) — feature-flagged, graceful fallback
            if (ctx.fullPlugin.settings.enableResearchStreamingSynthesis) {
                this.streamAbortController = new AbortController();
                cb.hideThinking();
                let accumulated = '';
                const result = await this.orchestrator.synthesizeStream(
                    successful, this.lastQuestion,
                    (chunk) => {
                        accumulated += chunk;
                        cb.updateAssistantMessage(accumulated);
                    },
                    {
                        signal: this.streamAbortController.signal,
                        noteContext: ctx.options.noteContent?.slice(0, 20_000),
                        language, includeCitations, citationStyle,
                        searchResults: this.searchResults,
                    },
                );
                this.lastSynthesis = result.synthesis;
                this.sourceMetadata = result.sourceMetadata;
                // Final update with citation-verified content
                cb.updateAssistantMessage(result.synthesis);
            } else {
                const result = await this.orchestrator.synthesize(
                    successful, this.lastQuestion,
                    ctx.options.noteContent?.slice(0, 20_000), language, includeCitations,
                    { citationStyle, searchResults: this.searchResults },
                );
                this.lastSynthesis = result.synthesis;
                this.sourceMetadata = result.sourceMetadata;
                cb.addAssistantMessage(result.synthesis);
            }
            this.setPhase('done');
        } finally {
            this.streamAbortController = null;
            cb.hideThinking();
            this.rerenderContextPanel();
            cb.rerenderActions();
        }
    }

    private async actionInsertAtCursor(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const editor = cb.getEditor();
        if (!editor || !this.lastSynthesis) return;
        editor.replaceSelection(this.lastSynthesis);
        ensureNoteStructureIfEnabled(editor, ctx.fullPlugin.settings);
        cb.notify(t.insertedResearch || 'Research inserted into note');
        this.sessionCleared = true;
        await this.orchestrator.clearSession();
    }

    private async actionAddAsSection(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const editor = cb.getEditor();
        if (!editor || !this.lastSynthesis) return;
        appendAsNewSections(editor, this.lastSynthesis);
        ensureNoteStructureIfEnabled(editor, ctx.fullPlugin.settings);
        cb.notify(t.addedAsSection || 'Research added as section');
        this.sessionCleared = true;
        await this.orchestrator.clearSession();
    }

    private actionSaveToPending(ctx: ModalContext, cb: ActionCallbacks): void {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const editor = cb.getEditor();
        if (!editor) return;
        const urls = this.selectedUrls.map(u => `- ${u}`).join('\n');
        const doc = editor.getValue();
        if (doc.includes('## Pending')) {
            editor.setValue(doc.replace(/(## Pending\n)/, `$1${urls}\n`));
        } else {
            editor.setValue(doc + '\n\n## Pending\n' + urls + '\n');
        }
        cb.notify(t.savedToPending || 'Source URLs saved to Pending section');
    }

    // Phase 3: Save extracted findings as a separate research note (with folder picker)
    private actionSaveFindings(ctx: ModalContext, cb: ActionCallbacks): void {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        // Capture active file path synchronously — avoids race if user switches notes
        const activeFile = ctx.app.workspace.getActiveFile();
        const defaultFolder = activeFile?.parent?.path
            || getResearchOutputFullPath(ctx.fullPlugin.settings);

        const picker = new FolderScopePickerModal(ctx.app, ctx.fullPlugin, {
            title: t.researchChooseFolder || 'Choose folder for research note',
            defaultFolder,
            allowSkip: false,
            allowNewFolder: true,
            onSelect: (folderPath: string | null) => {
                if (!folderPath) return;
                void this.doSaveFindings(folderPath, ctx, cb);
            },
        });
        picker.open();
    }

    /** Persist research findings to a note in the chosen folder */
    private async doSaveFindings(folder: string, ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        try {
            await ensureFolderExists(ctx.app.vault, folder);

            const date = new Date().toISOString().slice(0, 10);
            // Extract synthesized heading from LLM output for a descriptive filename
            const headingMatch = this.lastSynthesis?.match(/^##\s*Research[:\s\u2014-]+(.+)$/mi);
            const titleFromSynthesis = headingMatch?.[1]?.trim();
            const safeTitle = (titleFromSynthesis || this.lastQuestion).slice(0, 50).replace(/[\\/:*?"<>|]/g, '_');
            const fileName = `${folder}/Research — ${safeTitle} (${date}).md`;

            // Build content: synthesis + source details
            const escapedQuestion = this.lastQuestion.replaceAll('"', String.raw`\"`);
            let content = `---\nresearch_question: "${escapedQuestion}"\ndate: ${date}\n---\n\n`;
            if (this.lastSynthesis) {
                content += this.lastSynthesis + '\n\n';
            }

            // Add source findings section
            if (Object.keys(this.sourceSummaries).length > 0) {
                content += '---\n\n## Source Findings\n\n';
                for (const url of this.selectedUrls) {
                    if (this.sourceSummaries[url]) {
                        const result = this.searchResults.find(r => r.url === url);
                        content += `### ${result?.title || url}\n`;
                        content += `*Source: [${url}](${url})*\n\n`;
                        content += this.sourceSummaries[url] + '\n\n';
                    }
                }
            }

            // Create the note
            const existing = ctx.app.vault.getAbstractFileByPath(fileName);
            if (existing && existing instanceof TFile) {
                await ctx.app.vault.modify(existing, content);
            } else {
                await ctx.app.vault.create(fileName, content);
            }

            cb.notify((t.researchSaveFindingsSuccess || 'Source findings saved to {path}').replace('{path}', fileName));
        } catch (e) {
            cb.addSystemNotice(`Save failed: ${(e as Error).message}`);
        }
    }

    // Phase 3: Send sources to Zotero or copy CSL-JSON to clipboard
    private async actionSendToZotero(ctx: ModalContext, cb: ActionCallbacks): Promise<void> {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        if (this.sourceMetadata.length === 0) return;

        const cslItems = this.zoteroBridge.toCslJson(this.sourceMetadata);

        if (this.zoteroBridge.isAvailable(ctx.app)) {
            // Try sending to Zotero
            const collection = ctx.fullPlugin.settings.researchZoteroCollection;
            const result = await this.zoteroBridge.sendToZotero(cslItems, collection);
            if (result.success) {
                cb.notify((t.researchZoteroSuccess || 'Sent {count} references to Zotero')
                    .replace('{count}', String(cslItems.length)));
            } else {
                // Fallback to clipboard
                await this.zoteroBridge.copyToClipboard(cslItems);
                cb.notify(t.researchZoteroFallback || 'Zotero unavailable — copied CSL-JSON to clipboard');
            }
        } else {
            // No Zotero — copy CSL-JSON to clipboard
            await this.zoteroBridge.copyToClipboard(cslItems);
            cb.notify((t.researchCopyCslJson || 'Copy Citations (CSL-JSON)') + ' — copied to clipboard');
        }
    }

    onClear(): void {
        this.conversationHistory = [];
        this.setPhase('idle');
        this.searchResults = [];
        this.selectedUrls = [];
        this.sourceSummaries = {};
        this.lastSynthesis = null;
        this.sourceMetadata = [];
        this.lastQuestion = '';
        this.pendingPrecheckQuery = null;
        this.pendingPrecheckResult = null;
        this.currentSearchQuery = null;
        this.forceNewSearch = false;
        void this.orchestrator.clearSession();
        this.rerenderContextPanel();
    }

    dispose(): void {
        // Abort any active streaming synthesis
        this.streamAbortController?.abort();
        this.streamAbortController = null;

        // Close any active Scraping Browser WebSocket connections
        this.orchestrator.forceCleanup();

        // Only save session if it hasn't been explicitly cleared (by insert/section actions)
        if (this.searchResults.length > 0 && !this.sessionCleared) {
            void this.orchestrator.saveSession({
                question: this.lastQuestion,
                searchResults: this.searchResults,
                selectedUrls: this.selectedUrls,
                sourceSummaries: this.sourceSummaries,
                synthesis: this.lastSynthesis ?? undefined,
                provider: (this.plugin.settings.researchProvider || 'claude-web-search') as SearchProviderType,
                siteScope: this.siteScope,
                dateRange: this.dateRange,
                phase: this.phase,
                timestamp: Date.now(),
                academicMode: this.academicMode,
                perspectiveMode: this.perspectiveMode,
                sourceMetadata: this.sourceMetadata,
                conversationHistory: this.conversationHistory.length > 0
                    ? this.conversationHistory : undefined,
            });
        }
        this.contextPanelContainer = null;
        this.lastCtx = null;
        this.searchResults = [];
        this.selectedUrls = [];
        this.sourceSummaries = {};
        this.lastSynthesis = null;
        this.sourceMetadata = [];
        this.conversationHistory = [];
    }

    // ═══ PRIVATE HELPERS ═══

    private rerenderContextPanel(): void {
        if (!this.contextPanelContainer || !this.lastCtx) return;
        this.contextPanelContainer.empty();
        this.renderContextPanel(this.contextPanelContainer, this.lastCtx);
    }

    // Phase 3: Budget warning banner
    private renderBudgetBanner(container: HTMLElement, ctx: ModalContext): void {
        if (!ctx.fullPlugin.settings.enableResearchUsageGuardrails) return;
        const status = this.usageService.getBudgetStatus();
        if (status.level === 'ok') return;

        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const banner = container.createEl('div', {
            cls: `ai-organiser-research-budget-banner ai-organiser-research-budget-${status.level}`,
        });

        if (status.level === 'warn') {
            banner.createEl('span', {
                text: (t.researchBudgetWarn || 'Estimated spend: ~${amount} of ${budget} monthly budget ({percent}%)')
                    .replace('${amount}', `$${status.estimatedSpendUsd.toFixed(2)}`)
                    .replace('${budget}', `$${status.budgetUsd.toFixed(2)}`)
                    .replace('{percent}', String(status.percentUsed)),
            });
        } else if (status.level === 'blocked') {
            banner.createEl('span', {
                text: (t.researchBudgetBlocked || 'Monthly budget limit reached (~${amount}). Override or skip.')
                    .replace('${amount}', `$${status.estimatedSpendUsd.toFixed(2)}`),
            });
        }
    }

    private renderControlsRow(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const row = container.createEl('div', { cls: 'ai-organiser-research-controls' });

        // Provider dropdown (populated dynamically from configured providers)
        row.createEl('span', { text: t.providerLabel || 'Search:', cls: 'ai-organiser-research-control-label' });
        const providerSelect = row.createEl('select');
        const PROVIDER_LABELS: Record<SearchProviderType, string> = {
            'tavily': 'Tavily',
            'brightdata-serp': 'Bright Data SERP',
            'claude-web-search': 'Claude Web Search',
        };
        // Async population — show active provider immediately, then add available ones
        const activeProv = ctx.fullPlugin.settings.researchProvider as SearchProviderType;
        providerSelect.createEl('option', { text: PROVIDER_LABELS[activeProv] || activeProv, value: activeProv });
        providerSelect.value = activeProv;
        void this.searchService.getAvailableProviders().then(available => {
            providerSelect.empty();
            const toShow = new Set<SearchProviderType>(available);
            toShow.add(activeProv); // Always include the current setting
            for (const pType of toShow) {
                const opt = providerSelect.createEl('option', { text: PROVIDER_LABELS[pType] || pType, value: pType });
                if (pType === activeProv) opt.selected = true;
            }
        });
        providerSelect.addEventListener('change', () => { void (async () => {
            ctx.fullPlugin.settings.researchProvider = providerSelect.value as SearchProviderType;
            await ctx.fullPlugin.saveSettings();
            // Re-init search service with new provider
            this.searchService = new ResearchSearchService(ctx.fullPlugin);
            this.orchestrator = new ResearchOrchestrator(this.searchService, ctx.fullPlugin, {
                usageService: this.usageService,
                qualityService: this.qualityService,
            });
        })(); });

        // Scope dropdown
        row.createEl('span', { text: t.scopeLabel || 'Scope:', cls: 'ai-organiser-research-control-label' });
        const scopeSelect = row.createEl('select');
        const scopes: Array<{ value: SiteScope; label: string }> = [
            { value: 'all', label: t.scopeAll || 'All sites' },
            { value: 'preferred', label: t.scopePreferred || 'My preferred' },
            { value: 'academic', label: t.scopeAcademic || 'Academic' },
        ];
        for (const s of scopes) {
            const opt = scopeSelect.createEl('option', { text: s.label, value: s.value });
            if (s.value === this.siteScope) opt.selected = true;
        }
        scopeSelect.addEventListener('change', () => {
            this.siteScope = scopeSelect.value as SiteScope;
        });

        // Recency dropdown (Fix 13)
        row.createEl('span', { text: t.recencyLabel || 'Time:', cls: 'ai-organiser-research-control-label' });
        const recencySelect = row.createEl('select');
        const recencyOptions: Array<{ value: string; label: string }> = [
            { value: 'any', label: t.recencyAny || 'Any time' },
            { value: 'recent', label: t.recencyRecent || 'Past week' },
            { value: 'year', label: t.recencyYear || 'Past year' },
        ];
        for (const r of recencyOptions) {
            const opt = recencySelect.createEl('option', { text: r.label, value: r.value });
            if (r.value === (this.dateRange || 'any')) opt.selected = true;
        }
        recencySelect.addEventListener('change', () => {
            this.dateRange = recencySelect.value as 'recent' | 'year' | 'any';
        });

        // Phase 3: Academic mode toggle
        const academicLabel = row.createEl('label', { cls: 'ai-organiser-research-toggle-label' });
        const academicCheckbox = academicLabel.createEl('input', { type: 'checkbox' });
        (academicCheckbox).checked = this.academicMode;
        academicLabel.createEl('span', { text: t.researchAcademicMode || 'Academic Mode' });
        academicCheckbox.addEventListener('change', () => {
            this.academicMode = (academicCheckbox).checked;
        });
    }

    /**
     * Show clickable highlight snippets from the active note so the user
     * can pick one as their research query.
     */
    private renderHighlightPicker(container: HTMLElement, ctx: ModalContext): void {
        const content = ctx.options.noteContent;
        if (!content) return;

        const spans = extractHighlightSpans(content);
        if (spans.length === 0) return;

        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const section = container.createEl('div', { cls: 'ai-organiser-research-highlights' });
        section.createEl('div', {
            cls: 'ai-organiser-research-highlights-label',
            text: t.researchHighlightsLabel || 'Highlights in note — click to research:',
        });

        const list = section.createEl('div', { cls: 'ai-organiser-research-highlights-list' });
        for (const span of spans) {
            const chip = list.createEl('button', {
                cls: 'ai-organiser-research-highlight-chip',
                text: span.length > 120 ? span.slice(0, 117) + '...' : span,
                attr: { title: span },
            });
            chip.addEventListener('click', () => {
                this.onFillInput?.(span);
            });
        }
    }

    private renderPhaseStepper(container: HTMLElement): void {
        const stepper = container.createEl('div', {
            cls: 'ai-organiser-research-stepper',
            attr: { role: 'progressbar', 'aria-label': `Research progress: ${this.phase}` },
        });

        const isClaudeWS = this.plugin.settings.researchProvider === 'claude-web-search';

        const steps: Array<{ key: string; phases: ResearchPhase[] }> = isClaudeWS
            ? [
                { key: 'phaseSearch', phases: ['searching', 'continuing'] },
                { key: 'phaseSynthesize', phases: ['done'] },
              ]
            : [
                { key: 'phaseSearch', phases: ['searching', 'continuing'] },
                { key: 'phaseReview', phases: ['reviewing'] },
                { key: 'phaseExtract', phases: ['extracting'] },
                { key: 'phaseSynthesize', phases: ['synthesizing'] },
              ];

        const phaseIdx = PHASE_ORDER.indexOf(this.phase);

        steps.forEach((step) => {
            const stepPhaseIdx = PHASE_ORDER.indexOf(step.phases.at(-1) as ResearchPhase);
            const isActive = step.phases.includes(this.phase);
            const isComplete = phaseIdx > stepPhaseIdx;

            const stepEl = stepper.createEl('div', {
                cls: `ai-organiser-research-step ${isActive ? 'ai-organiser-research-step-active' : ''} ${isComplete ? 'ai-organiser-research-step-complete' : ''}`,
            });

            stepEl.createEl('span', { cls: 'ai-organiser-research-step-dot', text: isComplete ? '✓' : '' });

            if (!Platform.isMobile) {
                const ct = this.lastCtx?.plugin.t.modals.unifiedChat as Record<string, string>;
                const label = stepEl.createEl('span', {
                    cls: 'ai-organiser-research-step-label',
                    text: ct?.[step.key] || step.key,
                });

                // Show current search query below the searching step during streaming
                if (isActive && step.key === 'phaseSearch' && this.currentSearchQuery) {
                    const truncated = this.currentSearchQuery.length > 60
                        ? this.currentSearchQuery.slice(0, 57) + '...'
                        : this.currentSearchQuery;
                    label.createEl('span', {
                        cls: 'ai-organiser-research-step-detail',
                        text: truncated,
                    });
                }
            }
        });
    }

    /** Wraps result cards in a collapsible <details> — auto-collapsed in done phase. */
    private renderResultsSection(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;
        const isDone = this.phase === 'done' || this.phase === 'synthesizing';

        const summaryText = (t.researchResultsSummary || '{total} sources found · {selected} selected')
            .replace('{total}', String(this.searchResults.length))
            .replace('{selected}', String(this.selectedUrls.length));

        const details = container.createEl('details', {
            cls: 'ai-organiser-research-results-section',
        });

        // Auto-expand in active phases; in done phase respect manual override
        if (!isDone || this.resultsManuallyExpanded) {
            details.open = true;
        }

        const summary = details.createEl('summary', {
            cls: 'ai-organiser-research-results-summary',
            attr: { role: 'button', 'aria-expanded': String(details.open) },
        });
        summary.createEl('span', {
            text: summaryText,
            cls: 'ai-organiser-research-results-summary-text',
        });

        // Track manual expand/collapse in done phase
        details.addEventListener('toggle', () => {
            this.resultsManuallyExpanded = details.open;
            summary.setAttribute('aria-expanded', String(details.open));
        });

        this.renderResultCards(details, ctx);
    }

    private renderResultCards(container: HTMLElement, ctx: ModalContext): void {
        const t = ctx.plugin.t.modals.unifiedChat as Record<string, string>;

        const resultsContainer = container.createEl('div', {
            cls: 'ai-organiser-research-results',
            attr: { role: 'listbox', 'aria-multiselectable': 'true' },
        });

        for (const result of this.searchResults) {
            const isSelected = this.selectedUrls.includes(result.url);
            const card = resultsContainer.createEl('div', {
                cls: `ai-organiser-research-card ${isSelected ? 'ai-organiser-research-card-selected' : ''}`,
                attr: {
                    role: 'option',
                    tabindex: '0',
                    'aria-selected': String(isSelected),
                },
            });

            const checkbox = card.createEl('input', {
                type: 'checkbox',
                cls: 'ai-organiser-research-card-checkbox',
            });
            (checkbox).checked = isSelected;

            // Phase 3: Quality badge (if quality scoring enabled and score exists)
            if (result.qualityScore !== undefined && ctx.fullPlugin.settings.enableResearchQualityScoring) {
                const label = SourceQualityService.getQualityLabel(result.qualityScore);
                const labelKey = `researchQuality${label}`;
                const badgeCls = `ai-organiser-research-quality-badge ai-organiser-research-quality-${label.toLowerCase()}`;
                const badge = card.createEl('span', {
                    text: t[labelKey] || label,
                    cls: badgeCls,
                });

                // Quality tooltip with signal breakdown
                if (result.qualitySignals) {
                    const s = result.qualitySignals;
                    badge.title = (t.researchQualityTooltip || 'Relevance: {relevance} · Authority: {authority} · Fresh: {freshness} · Depth: {depth} · Diversity: {diversity}')
                        .replace('{relevance}', s.relevance.toFixed(2))
                        .replace('{authority}', s.authority.toFixed(2))
                        .replace('{freshness}', s.freshness.toFixed(2))
                        .replace('{depth}', s.depth.toFixed(2))
                        .replace('{diversity}', s.diversity.toFixed(2));
                }
            }

            card.createEl('span', { text: result.title, cls: 'ai-organiser-research-card-title' });

            // Meta line: domain, date, optional DOI, optional perspective
            let metaText = `${result.domain}${result.date ? ' · ' + result.date : ''}`;
            if (result.doi) metaText += ` · DOI: ${result.doi}`;
            card.createEl('div', { text: metaText, cls: 'ai-organiser-research-card-meta' });

            // Phase 3: Perspective chip
            if (result.perspective) {
                card.createEl('span', {
                    text: result.perspective,
                    cls: 'ai-organiser-research-perspective-chip',
                });
            }

            if (result.triageAssessment) {
                card.createEl('div', { text: result.triageAssessment, cls: 'ai-organiser-research-card-snippet' });
            } else if (result.snippet) {
                card.createEl('div', { text: result.snippet.slice(0, 150), cls: 'ai-organiser-research-card-snippet' });
            }

            const toggleSelection = () => {
                const idx = this.selectedUrls.indexOf(result.url);
                if (idx >= 0) {
                    this.selectedUrls.splice(idx, 1);
                } else {
                    this.selectedUrls.push(result.url);
                }
                this.rerenderContextPanel();
            };

            card.addEventListener('click', toggleSelection);
            card.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    toggleSelection();
                }
            });
        }

        // Card action bar
        const actionsBar = container.createEl('div', { cls: 'ai-organiser-research-card-actions' });

        actionsBar.createEl('span', {
            cls: 'ai-organiser-research-selection-count',
            text: `${this.selectedUrls.length} selected`,
            attr: { 'aria-live': 'polite' },
        });

        if (this.phase === 'reviewing') {
            new ButtonComponent(actionsBar)
                .setButtonText(t.searchAgain || 'Search Again')
                .setTooltip(t.searchAgainTooltip || 'Run an additional search')
                .onClick(() => {
                    // Set flag to bypass contextual answer on next send (AD-5 explicit bypass)
                    this.forceNewSearch = true;
                    // Focus input so user can type their follow-up query
                    const textarea = this.contextPanelContainer?.closest('.modal')?.querySelector('.ai-organiser-chat-input-row textarea') as HTMLTextAreaElement | null;
                    if (textarea) {
                        textarea.focus();
                    }
                });
        }
    }

    // Phase 3: Usage footer showing estimated spend
    private renderUsageFooter(container: HTMLElement): void {
        if (!this.plugin.settings.enableResearchUsageGuardrails) return;
        const summary = this.usageService.getUsageSummary();
        if (summary.operations === 0) return;

        container.createEl('div', {
            text: `Usage: ${summary.estimatedUsd} est. · ${summary.operations} paid ops`,
            cls: 'ai-organiser-research-usage-footer',
        });
    }

    private mergeResults(newResults: SearchResult[]): void {
        const existingUrls = new Set(this.searchResults.map(r => normalizeUrl(r.url)));
        for (const result of newResults) {
            if (!existingUrls.has(normalizeUrl(result.url))) {
                this.searchResults.push(result);
                existingUrls.add(normalizeUrl(result.url));
            }
        }
    }

    private parseSiteList(csv: string | undefined): string[] {
        if (!csv) return [];
        return csv.split(',').map(s => s.trim()).filter(Boolean);
    }
}
