/**
 * Integration Commands
 * Commands for adding content to Pending Integration and integrating it into notes
 */

import { Editor, MarkdownView, Notice, Modal, App, Setting, TextAreaComponent, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import type { Translations } from '../i18n';
import {
    addToPendingIntegration,
    getPendingIntegrationContent,
    setPendingIntegrationContent,
    getMainContent,
    clearPendingIntegration,
    replaceMainContent,
    ensureStandardStructure,
    PendingSource,
    SourceType,
    getTodayDate,
    addToReferencesSection,
    extractSourcesFromPending,
    getReferencesContent,
    SourceReference
} from '../utils/noteStructure';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, PlacementStrategy, FormatStrategy, DetailStrategy, DEFAULT_PLACEMENT_STRATEGY, DEFAULT_FORMAT_STRATEGY, DEFAULT_DETAIL_STRATEGY } from '../core/constants';
import { getPlacementInstructions, getFormatInstructions, getDetailInstructions } from '../services/prompts/integrationPrompts';
import { insertAtCursor, appendAsNewSections } from '../utils/editorUtils';
import { showReviewOrApply } from '../utils/reviewEditsHelper';
import { detectEmbeddedContent, DetectedContent } from '../utils/embeddedContentDetector';
import { DocumentExtractionService } from '../services/documentExtractionService';
import { ContentExtractionService, ExtractionResult, AudioTranscriptionConfig, PdfExtractionConfig } from '../services/contentExtractionService';
import { PersonaSelectModal, createPersonaButton } from '../ui/modals/PersonaSelectModal';
import type { Persona } from '../services/configurationService';
import { summarizeText, pluginContext } from '../services/llmFacade';
import { withBusyIndicator, showBusy, hideBusy } from '../utils/busyIndicator';
import { showErrorNotice, showSuccessNotice } from '../utils/executeWithNotice';
import { getYouTubeGeminiApiKey, getAudioTranscriptionApiKey, getAuditProviderConfig } from '../services/apiKeyHelpers';
import { getPdfProviderConfig } from '../services/pdfTranslationService';
import { ensurePrivacyConsent } from '../services/privacyNotice';
import { getMaxContentChars, truncateAtBoundary } from '../services/tokenLimits';
import { validateIntegrationOutput } from '../services/validators/integrationValidator';
import { auditIntegrationWithLLM } from '../services/validators/integrationAuditor';

/**
 * Drop the current editor selection into the Pending Integration section.
 * Called from the right-click context menu. Instant (no modal).
 */
export function dropSelectionToPending(plugin: AIOrganiserPlugin, editor: Editor): void {
    const selection = editor.getSelection();

    if (!selection || !selection.trim()) {
        new Notice(plugin.t.messages.selectTextFirst);
        return;
    }

    const contentType = detectContentType(selection.trim(), plugin.t);
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const defaultTitle = contentType.type === 'manual'
        ? plugin.t.messages.addedTimestamp.replace('{time}', timestamp)
        : getDefaultSourceTitle(plugin.t, contentType.type);

    const source: PendingSource = {
        type: contentType.type,
        title: contentType.title || defaultTitle,
        date: getTodayDate(),
        content: selection.trim(),
        link: contentType.link
    };

    addToPendingIntegration(editor, source);

    if (contentType.link) {
        const sourceRef: SourceReference = {
            type: contentType.type,
            title: contentType.title || defaultTitle,
            link: contentType.link,
            date: getTodayDate(),
            isInternal: contentType.isInternal || false
        };
        addToReferencesSection(editor, sourceRef);
    }

    new Notice(plugin.t.messages.selectionAddedToPending);
}

export function registerIntegrationCommands(plugin: AIOrganiserPlugin): void {
    // Command: Add content to Pending Integration
    plugin.addCommand({
        id: 'add-to-pending-integration',
        name: plugin.t.commands.addToPendingIntegration,
        icon: 'plus-circle',
        editorCallback: async (editor: Editor) => {
            const modal = new AddContentModal(plugin.app, plugin.t, (result) => {
                if (result) {
                    addToPendingIntegration(editor, result);

                    // If there's a link, also add to References
                    if (result.link) {
                        const sourceRef: SourceReference = {
                            type: result.type,
                            title: result.title,
                            link: result.link,
                            date: result.date,
                            isInternal: !result.link.startsWith('http')
                        };
                        addToReferencesSection(editor, sourceRef);
                    }

                    new Notice(plugin.t.messages.contentAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Integrate pending content
    plugin.addCommand({
        id: 'integrate-pending-content',
        name: plugin.t.commands.integratePendingContent,
        icon: 'git-merge',
        editorCallback: async (editor: Editor) => {
            const pendingContent = getPendingIntegrationContent(editor);

            if (!pendingContent) {
                new Notice(plugin.t.messages.noPendingContentToIntegrate);
                return;
            }

            const mainContent = getMainContent(editor);

            // Load personas and show confirmation modal with persona selection
            const personas = await plugin.configService.getPersonas();
            const defaultPersona = await plugin.configService.getDefaultPersona();

            const modal = new IntegrationConfirmModal(
                plugin.app,
                personas,
                defaultPersona,
                plugin.t,
                (selectedPersona, placement, format, detail, autoTag) => { void (async () => {
                    // Guard: callout/merge require main content
                    if ((placement === 'callout' || placement === 'merge') && !mainContent.trim()) {
                        new Notice(plugin.t.messages.noMainContentToIntegrateInto);
                        return;
                    }

                    new Notice(plugin.t.messages.integratingContent);

                    // Show busy indicator for the entire resolve + LLM flow
                    showBusy(plugin);
                    try {
                        // Get persona prompt
                        const personaPrompt = await plugin.configService.getPersonaPrompt(selectedPersona.id);

                        // Resolve embedded content (includes privacy consent)
                        new Notice(plugin.t.messages.integrationResolvingContent);
                        const resolutionResult = await resolveAllPendingContent(
                            plugin,
                            pendingContent,
                            plugin.app.workspace.getActiveFile() || undefined,
                            (message, current, total) => {
                                new Notice(
                                    plugin.t.messages.integrationResolvingProgress
                                        .replace('{current}', String(current))
                                        .replace('{total}', String(total))
                                        .replace('{item}', message)
                                );
                            }
                        );

                        if (resolutionResult.errors.includes(plugin.t.messages.operationCancelled)) {
                            new Notice(plugin.t.messages.operationCancelled);
                            return;
                        }

                        if (resolutionResult.resolvedCount > 0) {
                            new Notice(
                                plugin.t.messages.integrationResolutionComplete
                                    .replace('{count}', String(resolutionResult.resolvedCount))
                            );
                        }

                        let enrichedPending = resolutionResult.enrichedContent;

                        // Apply truncation budget based on provider limits
                        const serviceType = plugin.settings.serviceType === 'cloud'
                            ? plugin.settings.cloudServiceType
                            : 'local';
                        const truncationResult = truncatePendingContentForIntegration(
                            enrichedPending,
                            mainContent,
                            placement,
                            serviceType
                        );
                        enrichedPending = truncationResult.content;
                        if (truncationResult.wasTruncated) {
                            new Notice(plugin.t.messages.integrationContentTruncated);
                        }

                        // Build the integration prompt with strategy params
                        const prompt = buildIntegrationPrompt(mainContent, enrichedPending, plugin, personaPrompt, placement, format, detail);

                        // Call the LLM service
                        const response = await callLLMForIntegration(plugin, prompt);

                        if (!response.success || !response.content) {
                            const errorMessage = response.error || plugin.t.messages.noResponseFromLlm;
                            showErrorNotice(plugin.t.messages.integratingContentFailed.replace('{error}', errorMessage));
                            return;
                        }

                        // Validate LLM output before insertion (Phase 3 deterministic validation)
                        const validation = validateIntegrationOutput(response.content, {
                            placement,
                            format,
                            originalContent: mainContent,
                            pendingContent: enrichedPending
                        });
                        const contentToInsert = validation.data;

                        if (validation.issues.length > 0) {
                            logger.debug('Integration', 'Integration validation:', validation.issues);
                        }

                        const warnings = validation.issues.filter(i => i.severity === 'warning');
                        if (warnings.length > 0) {
                            new Notice(plugin.t.messages.integrationValidationWarnings.replace('{count}', String(warnings.length)), 4000);
                        }

                        // Phase 6: Optional LLM audit for merge/callout (DD-5: fail-open)
                        if (plugin.settings.enableLLMAudit && plugin.llmService
                            && (placement === 'merge' || placement === 'callout')) {
                            try {
                                const providerConfig = await getAuditProviderConfig(plugin);
                                const audit = await auditIntegrationWithLLM(
                                    contentToInsert, mainContent, enrichedPending,
                                    placement, format,
                                    plugin.llmService,
                                    providerConfig,
                                    { app: plugin.app }
                                );
                                if (!audit.approved) {
                                    new Notice(plugin.t.messages.auditFlaggedIntegration.replace('{count}', String(audit.issues.length)), 6000);
                                }
                                if (audit.issues.length > 0) {
                                    logger.debug('Integration', 'Integration audit:', audit.issues);
                                }
                            } catch {
                                logger.debug('Integration', 'Integration audit skipped (error)');
                            }
                        }

                        // Apply content based on placement strategy.
                        // cursor/append write immediately — reviewAction stays 'accept' (no review modal).
                        let reviewAction: 'accept' | 'copy' | 'reject' = 'accept';
                        if (placement === 'cursor') {
                            insertAtCursor(editor, contentToInsert);
                        } else if (placement === 'append') {
                            appendAsNewSections(editor, contentToInsert);
                        } else {
                            // callout or merge — rewrite main content, with diff review
                            reviewAction = await showReviewOrApply(
                                plugin,
                                mainContent,
                                contentToInsert,
                                () => replaceMainContent(editor, contentToInsert)
                            );
                        }

                        // Post-processing only when content was actually applied
                        if (reviewAction === 'accept') {
                            movePendingSourcesToReferences(editor, pendingContent);
                            clearPendingIntegration(editor);

                            if (autoTag) {
                                const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                                if (view?.file) {
                                    const noteContent = editor.getValue();
                                    await plugin.analyzeAndTagNote(view.file, noteContent);
                                }
                            }

                            showSuccessNotice(plugin.t.messages.contentIntegratedSuccessfully);
                        }

                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        showErrorNotice(plugin.t.messages.integratingContentFailed.replace('{error}', errorMessage));
                    } finally {
                        hideBusy(plugin);
                    }
                })(); }
            );
            modal.open();
        }
    });

    // Command: Resolve pending embeds
    plugin.addCommand({
        id: 'resolve-pending-embeds',
        name: plugin.t.commands.resolvePendingEmbeds,
        icon: 'scan-text',
        editorCallback: async (editor: Editor) => {
            await resolvePendingEmbeds(plugin, editor);
        }
    });

    // Command: Ensure standard note structure
    plugin.addCommand({
        id: 'ensure-note-structure',
        name: plugin.t.commands.ensureNoteStructure,
        icon: 'layout-template',
        editorCallback: (editor: Editor) => {
            ensureStandardStructure(editor);
            new Notice(plugin.t.messages.noteStructureAdded);
        }
    });

    // Command: Quick add text to pending
    plugin.addCommand({
        id: 'quick-add-text-pending',
        name: plugin.t.commands.quickAddTextPending,
        icon: 'text',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickTextModal(plugin.app, plugin.t, (text) => {
                if (text) {
                    // Simple format - just number and content
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const source: PendingSource = {
                        type: 'manual',
                        title: plugin.t.messages.addedTimestamp.replace('{time}', timestamp),
                        date: getTodayDate(),
                        content: text
                    };
                    addToPendingIntegration(editor, source);
                    new Notice(plugin.t.messages.contentAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Quick add URL to pending
    plugin.addCommand({
        id: 'quick-add-url-pending',
        name: plugin.t.commands.quickAddUrlPending,
        icon: 'link',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickUrlModal(plugin.app, plugin.t, (url) => {
                if (url) {
                    const defaultTitle = getDefaultSourceTitle(plugin.t, 'web');
                    const source: PendingSource = {
                        type: 'web',
                        title: defaultTitle,
                        date: getTodayDate(),
                        content: url,  // Just the URL - AI will handle during integration
                        link: url
                    };
                    addToPendingIntegration(editor, source);

                    // Also add to references
                    const sourceRef: SourceReference = {
                        type: 'web',
                        title: defaultTitle,
                        link: url,
                        date: getTodayDate(),
                        isInternal: false
                    };
                    addToReferencesSection(editor, sourceRef);

                    new Notice(plugin.t.messages.urlAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Drop selection to pending (no modal, instant)
    plugin.addCommand({
        id: 'drop-selection-pending',
        name: plugin.t.commands.dropSelectionPending,
        icon: 'arrow-down-to-line',
        editorCallback: (editor: Editor) => {
            dropSelectionToPending(plugin, editor);
        }
    });
}

/**
 * Extract sources from pending content and add them to the References section,
 * skipping any that already exist (dedup by normalized link).
 */
function movePendingSourcesToReferences(editor: Editor, pendingContent: string): void {
    const sources = extractSourcesFromPending(pendingContent);
    for (const source of sources) {
        const existingRefs = getReferencesContent(editor);
        const normalizedLink = source.isInternal ? `[[${source.link}]]` : source.link;
        if (!existingRefs.includes(normalizedLink)) {
            addToReferencesSection(editor, source);
        }
    }
}

export interface ContentResolutionResult {
    enrichedContent: string;
    resolvedCount: number;
    failedCount: number;
    errors: string[];
}

export async function resolveAllPendingContent(
    plugin: AIOrganiserPlugin,
    pendingContent: string,
    activeFile: TFile | undefined,
    onProgress?: (message: string, current: number, total: number) => void
): Promise<ContentResolutionResult> {
    const detection = detectEmbeddedContent(plugin.app, pendingContent, activeFile);
    const resolvableTypes = new Set(['web-link', 'youtube', 'pdf', 'document', 'audio', 'internal-link']);
    const resolvableItems = detection.items.filter(item => resolvableTypes.has(item.type));

    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    const providersToConsent: string[] = [];
    if (serviceType !== 'local') {
        providersToConsent.push(serviceType);
    }

    const hasYouTubeItems = resolvableItems.some(item => item.type === 'youtube');
    const hasAudioItems = resolvableItems.some(item => item.type === 'audio');
    const hasPdfItems = resolvableItems.some(item => item.type === 'pdf');

    const youtubeGeminiKey = hasYouTubeItems ? await getYouTubeGeminiApiKey(plugin) : null;
    if (hasYouTubeItems && youtubeGeminiKey) {
        providersToConsent.push('gemini');
    }

    const audioTranscriptionConfig = hasAudioItems ? await getAudioTranscriptionApiKey(plugin) : null;
    if (hasAudioItems && audioTranscriptionConfig) {
        providersToConsent.push(audioTranscriptionConfig.provider);
    }

    // Check for PDF-capable provider (Claude/Gemini multimodal)
    const pdfProviderConfig = hasPdfItems ? await getPdfProviderConfig(plugin) : null;
    if (hasPdfItems && pdfProviderConfig) {
        providersToConsent.push(pdfProviderConfig.provider);
    }

    const uniqueProviders = [...new Set(providersToConsent)];
    for (const provider of uniqueProviders) {
        const consentGiven = await ensurePrivacyConsent(plugin, provider);
        if (!consentGiven) {
            return {
                enrichedContent: pendingContent,
                resolvedCount: 0,
                failedCount: 0,
                errors: [plugin.t.messages.operationCancelled]
            };
        }
    }

    if (resolvableItems.length === 0) {
        return {
            enrichedContent: pendingContent,
            resolvedCount: 0,
            failedCount: 0,
            errors: []
        };
    }

    const errors: string[] = [];
    let itemsToResolve = [...resolvableItems];

    if (hasAudioItems && !audioTranscriptionConfig) {
        new Notice(plugin.t.messages.integrationAudioKeyMissing);
        errors.push(plugin.t.messages.integrationAudioKeyMissing);
        itemsToResolve = itemsToResolve.filter(item => item.type !== 'audio');
    }

    const youtubeConfig = youtubeGeminiKey
        ? {
            apiKey: youtubeGeminiKey,
            model: plugin.settings.youtubeGeminiModel,
            timeoutMs: plugin.settings.summarizeTimeoutSeconds * 1000
        }
        : undefined;

    const audioConfig: AudioTranscriptionConfig | undefined = audioTranscriptionConfig
        ? {
            provider: audioTranscriptionConfig.provider,
            apiKey: audioTranscriptionConfig.key
        }
        : undefined;

    // Configure multimodal PDF extraction if available
    const pdfConfig: PdfExtractionConfig | undefined = pdfProviderConfig
        ? {
            provider: pdfProviderConfig.provider,
            apiKey: pdfProviderConfig.apiKey,
            model: pdfProviderConfig.model,
            language: plugin.settings.summaryLanguage !== 'auto'
                ? plugin.settings.summaryLanguage
                : undefined
        }
        : undefined;

    const contentExtractionService = new ContentExtractionService(plugin.app, plugin.pdfService, plugin.documentExtractionService, youtubeConfig);
    contentExtractionService.setYouTubeGeminiConfig(youtubeConfig);
    contentExtractionService.setAudioTranscriptionConfig(audioConfig);
    contentExtractionService.setPdfExtractionConfig(pdfConfig);

    // textOnly=false when PDF config is available (enables multimodal extraction)
    const extractionResult = await contentExtractionService.extractContent(
        itemsToResolve,
        (current, total, item) => onProgress?.(item, current, total),
        !pdfConfig  // textOnly = true only when no multimodal PDF config
    );

    const enrichedContent = buildEnrichedContent(pendingContent, extractionResult);
    const resolvedCount = extractionResult.items.filter(item => item.success && item.content).length;
    const failedCount = extractionResult.items.filter(item => !item.success).length;

    return {
        enrichedContent,
        resolvedCount,
        failedCount,
        errors: [...errors, ...extractionResult.errors]
    };
}

function buildEnrichedContent(pendingContent: string, extractionResult: ExtractionResult): string {
    const lines = pendingContent.split('\n');

    const successItems = extractionResult.items
        .filter(item => item.success && item.content)
        .sort((a, b) => b.source.lineNumber - a.source.lineNumber);

    for (const item of successItems) {
        const lineIdx = item.source.lineNumber - 1;
        if (lineIdx < 0 || lineIdx >= lines.length) {
            continue;
        }

        const line = lines[lineIdx];
        const originalText = item.source.originalText;
        const pos = line.indexOf(originalText);
        if (pos === -1) {
            continue;
        }

        const replacement = `\n### Content: ${item.source.displayName}\n\n${item.content}\n`;
        lines[lineIdx] = line.slice(0, pos) + replacement + line.slice(pos + originalText.length);
    }

    return lines.join('\n');
}

export function truncatePendingContentForIntegration(
    pendingContent: string,
    mainContent: string,
    placement: PlacementStrategy,
    serviceType: string
): { content: string; wasTruncated: boolean; availableForPending: number } {
    const maxTotal = getMaxContentChars(serviceType);
    const promptOverhead = 2000;
    const mainContentChars = (placement === 'callout' || placement === 'merge')
        ? mainContent.length
        : 0;
    const availableForPending = maxTotal - mainContentChars - promptOverhead;

    if (availableForPending > 0 && pendingContent.length > availableForPending) {
        return {
            content: truncateAtBoundary(pendingContent, availableForPending, '\n\n[Pending content truncated...]'),
            wasTruncated: true,
            availableForPending
        };
    }

    return {
        content: pendingContent,
        wasTruncated: false,
        availableForPending
    };
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- SourceType still used in integration UI
function getDefaultSourceTitle(t: Translations, type: SourceType): string {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const typeLabels = t.modals.addContent.types as Record<SourceType, string>;
    return typeLabels[type] || t.modals.addContent.defaultTitle;
}

async function resolvePendingEmbeds(plugin: AIOrganiserPlugin, editor: Editor): Promise<void> {
    const t = plugin.t.integration;
    const pendingContent = getPendingIntegrationContent(editor);

    if (!pendingContent) {
        new Notice(t.noEmbedsToResolve);
        return;
    }

    const activeFile = plugin.app.workspace.getActiveFile() || undefined;
    const detected = detectEmbeddedContent(plugin.app, pendingContent, activeFile);
    const extractable = detected.items.filter(item => item.type === 'document' || item.type === 'pdf');

    if (extractable.length === 0) {
        new Notice(t.noEmbedsToResolve);
        return;
    }

    const typeCounts: Record<string, number> = {};
    for (const item of extractable) {
        typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    }
    const typesSummary = Object.entries(typeCounts)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');

    const foundMessage = t.embedsFound
        .replace('{count}', String(extractable.length))
        .replace('{types}', typesSummary);
    const confirmMessage = t.resolveConfirm;

    const proceed = await plugin.showConfirmationDialog(`${foundMessage}\n\n${confirmMessage}`);
    if (!proceed) {
        return;
    }

    const documentService = new DocumentExtractionService(plugin.app);
    let updatedContent = pendingContent;
    let resolvedCount = 0;

    for (const item of extractable) {
        const result = await extractPendingEmbedText(plugin, documentService, item);
        if (result.success && result.text) {
            const replacement = `\n\n### Extracted: ${item.displayName}\n\n${result.text}\n`;
            updatedContent = updatedContent.split(item.originalText).join(replacement);
            resolvedCount++;
        }
    }

    if (resolvedCount > 0) {
        setPendingIntegrationContent(editor, updatedContent);
    }

    new Notice(
        t.resolveSuccess.replace('{count}', String(resolvedCount))
    );
}

async function extractPendingEmbedText(
    plugin: AIOrganiserPlugin,
    documentService: DocumentExtractionService,
    item: DetectedContent
): Promise<{ success: boolean; text?: string; error?: string }> {
    if (item.isExternal) {
        if (item.type === 'document') {
            return await documentService.extractFromUrl(item.url);
        }
        return { success: false, error: 'External PDFs are not supported' };
    }

    let file = item.resolvedFile;
    if (!file) {
        const abstractFile = plugin.app.vault.getAbstractFileByPath(item.url);
        if (abstractFile instanceof TFile) {
            file = abstractFile;
        }
    }

    if (!file) {
        return { success: false, error: 'File not found' };
    }

    return await documentService.extractText(file);
}

/**
 * Detect content type from text
 */
function detectContentType(text: string, t: Translations): {
    type: SourceType; // eslint-disable-line @typescript-eslint/no-deprecated
    title?: string;
    link?: string;
    isInternal?: boolean;
} {
    const trimmed = text.trim();

    // Check for URL
    const urlMatch = trimmed.match(/^(https?:\/\/[^\s]+)$/);
    if (urlMatch) {
        // Check if it's YouTube
        if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
            return { type: 'youtube', title: getDefaultSourceTitle(t, 'youtube'), link: trimmed, isInternal: false };
        }
        return { type: 'web', title: getDefaultSourceTitle(t, 'web'), link: trimmed, isInternal: false };
    }

    // Check for wikilink [[...]]
    const wikilinkMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (wikilinkMatch) {
        return { type: 'note', title: wikilinkMatch[1], link: wikilinkMatch[1], isInternal: true };
    }

    // Check for embed ![[...]]
    const embedMatch = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
        const filename = embedMatch[1];
        const ext = filename.split('.').pop()?.toLowerCase();
        const extWithDot = ext ? `.${ext}` : '';

        if (IMAGE_EXTENSIONS.includes(extWithDot)) {
            return { type: 'image', title: filename, link: filename, isInternal: true };
        }
        if (extWithDot === '.pdf') {
            return { type: 'pdf', title: filename, link: filename, isInternal: true };
        }
        if (VIDEO_EXTENSIONS.includes(extWithDot)) {
            return { type: 'video', title: filename, link: filename, isInternal: true };
        }
        if (AUDIO_EXTENSIONS.includes(extWithDot)) {
            return { type: 'audio', title: filename, link: filename, isInternal: true };
        }
        return { type: 'note', title: filename, link: filename, isInternal: true };
    }

    // Default: plain text/manual notes
    return { type: 'manual' };
}

/**
 * Call LLM service for content integration
 */
async function callLLMForIntegration(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    return await withBusyIndicator(plugin, () => summarizeText(pluginContext(plugin), prompt));
}

/**
 * Build the prompt for integrating pending content
 */
export function buildIntegrationPrompt(
    mainContent: string,
    pendingContent: string,
    plugin: AIOrganiserPlugin,
    personaPrompt?: string,
    placement: PlacementStrategy = DEFAULT_PLACEMENT_STRATEGY,
    format: FormatStrategy = DEFAULT_FORMAT_STRATEGY,
    detail: DetailStrategy = DEFAULT_DETAIL_STRATEGY
): string {
    const language = plugin.settings.summaryLanguage || 'English';
    const personaSection = personaPrompt ? `\n${personaPrompt}\n` : '';
    const placementInstructions = getPlacementInstructions(placement);
    const formatInstructions = getFormatInstructions(format);
    const detailInstructions = getDetailInstructions(detail);

    const needsMainContent = placement === 'callout' || placement === 'merge';

    const mainContentSection = needsMainContent ? `
<main_content>
${mainContent}
</main_content>
` : '';

    return `<task>
You are helping to integrate new content into an existing note.

${placementInstructions}
</task>
${personaSection}
<requirements>
- Output ONLY the content - no explanations or meta-commentary
- Keep the same writing style as the main content
- ${formatInstructions}
- ${detailInstructions}
- If there are conflicting facts, include both with appropriate context
- Output in ${language}
</requirements>
${mainContentSection}
<pending_content_to_integrate>
${pendingContent}
</pending_content_to_integrate>

<output_format>
Return ONLY the integrated note content. Do not include:
- Any introductory text like "Here is the integrated content"
- The "## References" or "## Pending Integration" sections (these are managed separately)
- Any markdown code fences around the output
</output_format>`;
}

/**
 * Modal for confirming integration with persona selection
 */
class IntegrationConfirmModal extends Modal {
    private personas: Persona[];
    private selectedPersona: Persona;
    private onConfirm: (persona: Persona, placement: PlacementStrategy, format: FormatStrategy, detail: DetailStrategy, autoTag: boolean) => void;
    private personaButtonEl: HTMLElement | null = null;
    private t: Translations;
    private selectedPlacement: PlacementStrategy = DEFAULT_PLACEMENT_STRATEGY;
    private selectedFormat: FormatStrategy = DEFAULT_FORMAT_STRATEGY;
    private selectedDetail: DetailStrategy = DEFAULT_DETAIL_STRATEGY;
    private autoTag = false;

    constructor(
        app: App,
        personas: Persona[],
        defaultPersona: Persona,
        t: Translations,
        onConfirm: (persona: Persona, placement: PlacementStrategy, format: FormatStrategy, detail: DetailStrategy, autoTag: boolean) => void
    ) {
        super(app);
        this.personas = personas;
        this.selectedPersona = defaultPersona;
        this.t = t;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        const ic = this.t.modals.integrationConfirm;
        contentEl.empty();

        contentEl.createEl('h2', { text: ic.title });
        contentEl.createEl('p', {
            text: ic.description,
            cls: 'setting-item-description'
        });

        // Persona selector row
        if (this.personas.length > 1) {
            const personaRow = contentEl.createEl('div', { cls: 'ai-organiser-persona-selector-row' });
            personaRow.createEl('span', {
                text: ic.personaLabel,
                cls: 'ai-organiser-persona-selector-label'
            });

            this.personaButtonEl = createPersonaButton(
                personaRow,
                this.selectedPersona,
                () => this.openPersonaSelector()
            );
        }

        // Placement dropdown
        const placementSetting = new Setting(contentEl)
            .setName(ic.placementLabel)
            .setDesc(ic.placementDesc)
            .addDropdown(dd => dd
                .addOption('cursor', ic.placementCursor)
                .addOption('append', ic.placementAppend)
                .addOption('callout', ic.placementCallout)
                .addOption('merge', ic.placementMerge)
                .setValue(this.selectedPlacement)
                .onChange((value: string) => {
                    this.selectedPlacement = value as PlacementStrategy;
                    // Show merge warning dynamically
                    if (value === 'merge') {
                        placementSetting.setDesc(ic.placementMergeWarn);
                    } else {
                        placementSetting.setDesc(ic.placementDesc);
                    }
                }));

        // Format dropdown
        new Setting(contentEl)
            .setName(ic.formatLabel)
            .setDesc(ic.formatDesc)
            .addDropdown(dd => dd
                .addOption('prose', ic.formatProse)
                .addOption('bullets', ic.formatBullets)
                .addOption('tasks', ic.formatTasks)
                .addOption('table', ic.formatTable)
                .setValue(this.selectedFormat)
                .onChange((value: string) => {
                    this.selectedFormat = value as FormatStrategy;
                }));

        // Detail level dropdown
        new Setting(contentEl)
            .setName(ic.detailLabel)
            .setDesc(ic.detailDesc)
            .addDropdown(dd => dd
                .addOption('full', ic.detailFull)
                .addOption('concise', ic.detailConcise)
                .addOption('summary', ic.detailSummary)
                .setValue(this.selectedDetail)
                .onChange((value: string) => {
                    this.selectedDetail = value as DetailStrategy;
                }));

        // Auto-tag toggle
        new Setting(contentEl)
            .setName(ic.autoTagLabel)
            .setDesc(ic.autoTagDesc)
            .addToggle(toggle => toggle
                .setValue(this.autoTag)
                .onChange(value => {
                    this.autoTag = value;
                }));

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(ic.confirmButton)
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedPersona, this.selectedPlacement, this.selectedFormat, this.selectedDetail, this.autoTag);
                }));
    }

    private openPersonaSelector() {
        const modal = new PersonaSelectModal(
            this.app,
            this.t,
            this.personas,
            this.selectedPersona.id,
            (persona) => {
                this.selectedPersona = persona;
                this.updatePersonaButton();
            }
        );
        modal.open();
    }

    private updatePersonaButton() {
        if (this.personaButtonEl) {
            const label = this.personaButtonEl.querySelector('.ai-organiser-persona-button-label');
            if (label) {
                label.textContent = this.selectedPersona.name;
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Modal for adding content to Pending Integration
 */
class AddContentModal extends Modal {
    private result: PendingSource | null = null;
    private onSubmit: (result: PendingSource | null) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (result: PendingSource | null) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.addContent.title });

        let selectedType: SourceType = 'manual'; // eslint-disable-line @typescript-eslint/no-deprecated
        let title = '';
        let link = '';
        let content = '';

        // Source type dropdown
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceType)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('manual', this.t.modals.addContent.types.manual)
                    .addOption('web', this.t.modals.addContent.types.web)
                    .addOption('youtube', this.t.modals.addContent.types.youtube)
                    .addOption('audio', this.t.modals.addContent.types.audio)
                    .addOption('pdf', this.t.modals.addContent.types.pdf)
                    .addOption('image', this.t.modals.addContent.types.image)
                    .addOption('note', this.t.modals.addContent.types.note)
                    .setValue('manual')
                    .onChange(value => {
                        selectedType = value as SourceType; // eslint-disable-line @typescript-eslint/no-deprecated
                    });
            });

        // Title
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceTitle)
            .setDesc(this.t.modals.addContent.sourceTitleDesc)
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals.addContent.sourceTitlePlaceholder)
                    .onChange(value => {
                        title = value;
                    });
            });

        // Link (optional)
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceLink)
            .setDesc(this.t.modals.addContent.sourceLinkDesc)
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals.addContent.sourceLinkPlaceholder)
                    .onChange(value => {
                        link = value;
                    });
            });

        // Content
        const contentSetting = new Setting(contentEl)
            .setName(this.t.modals.addContent.content)
            .setDesc(this.t.modals.addContent.contentDesc);

        const textArea = new TextAreaComponent(contentSetting.controlEl);
        textArea
            .setPlaceholder(this.t.modals.addContent.contentPlaceholder)
            .onChange(value => {
                content = value;
            });
        textArea.inputEl.rows = 10;
        textArea.inputEl.addClass('ai-organiser-w-full');

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (!content.trim()) {
                        new Notice(this.t.messages.contentRequired);
                        return;
                    }

                    this.result = {
                        type: selectedType,
                        title: title || getDefaultSourceTitle(this.t, selectedType),
                        date: getTodayDate(),
                        content: content.trim(),
                        link: link || undefined
                    };
                    this.close();
                }));
    }

    onClose() {
        this.onSubmit(this.result);
        this.contentEl.empty();
    }
}

/**
 * Quick modal for adding text - simplified single textarea
 */
class QuickTextModal extends Modal {
    private onSubmit: (text: string) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (text: string) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.quickAddText.title });
        contentEl.createEl('p', {
            text: this.t.modals.quickAddText.description,
            cls: 'setting-item-description'
        });

        let text = '';

        const textArea = new TextAreaComponent(contentEl);
        textArea
            .setPlaceholder(this.t.modals.quickAddText.placeholder)
            .onChange(value => { text = value; });
        textArea.inputEl.rows = 10;
        textArea.inputEl.addClass('ai-organiser-w-full');
        textArea.inputEl.addClass('ai-organiser-mb-1em');

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (text.trim()) {
                        this.onSubmit(text.trim());
                    }
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Quick modal for adding URL - simplified
 */
class QuickUrlModal extends Modal {
    private onSubmit: (url: string) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (url: string) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.quickAddUrl.title });
        contentEl.createEl('p', {
            text: this.t.modals.quickAddUrl.description,
            cls: 'setting-item-description'
        });

        let url = '';

        new Setting(contentEl)
            .setName(this.t.modals.quickAddUrl.urlLabel)
            .addText(input => {
                input
                    .setPlaceholder(this.t.modals.quickAddUrl.urlPlaceholder)
                    .onChange(value => { url = value; });
                input.inputEl.addClass('ai-organiser-w-full');
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (url.trim()) {
                        this.onSubmit(url.trim());
                    }
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
