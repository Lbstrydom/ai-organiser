/**
 * Summarize Commands
 * Commands for URL and PDF summarization
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice, Platform, TFile, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { fetchArticle, openInBrowser, chunkContent, WebContent } from '../services/webContentService';
import { PdfService, PdfContent, PdfServiceResult } from '../services/pdfService';
import { buildSummaryPrompt, buildChunkCombinePrompt, insertContentIntoPrompt, insertSectionsIntoPrompt, SummaryPromptOptions } from '../services/prompts/summaryPrompts';
import { buildStructuredSummaryPrompt, insertContentIntoStructuredPrompt } from '../services/prompts/structuredPrompts';
import { parseStructuredResponse } from '../utils/responseParser';
import { updateAIOMetadata, createSummaryHook } from '../utils/frontmatterUtils';
import { SourceType, DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS } from '../core/constants';
import { getTranscriptFullPath } from '../core/settings';
import { ensureFolderExists } from '../utils/minutesUtils';
import { isContentTooLarge, getMaxContentChars, truncateContent, truncateAtBoundary, getProviderLimits } from '../services/tokenLimits';
import { ensurePrivacyConsent, resetPrivacyNotice } from '../services/privacyNotice';
import { isPdfUrl, extractFilenameFromUrl } from '../utils/urlValidator';
import { UrlInputModal } from '../ui/modals/UrlInputModal';
import { PdfSelectModal } from '../ui/modals/PdfSelectModal';
import { YouTubeInputModal } from '../ui/modals/YouTubeInputModal';
import { AudioSelectModal, AudioSelectResult } from '../ui/modals/AudioSelectModal';
import { AudioRecorderModal } from '../ui/modals/AudioRecorderModal';
import { isRecordingSupported } from '../services/audioRecordingService';
import { ContentSizeModal, ContentSizeChoice } from '../ui/modals/ContentSizeModal';
import { getLanguageNameForPrompt } from '../services/languages';
import {
    isYouTubeUrl,
    getYouTubeUrl,
    YouTubeVideoInfo,
    summarizeYouTubeWithGemini,
    transcribeYouTubeWithGemini
} from '../services/youtubeService';
import {
    transcribeExternalAudio,
    transcribeAudioWithFullWorkflow,
    AudioWorkflowProgress
} from '../services/audioTranscriptionService';
import {
    addToReferencesSection,
    SourceReference,
    getTodayDate,
    formatDuration,
    ensureNoteStructureIfEnabled
} from '../utils/noteStructure';
import { SummarizeSourceModal, SummarizeSourceOption } from '../ui/modals/SummarizeSourceModal';
import { MultiSourceModal, MultiSourceModalResult } from '../ui/modals/MultiSourceModal';
import { removeProcessedSources } from '../utils/sourceDetection';
import { DocumentExtractionService } from '../services/documentExtractionService';
import { summarizeText, pluginContext } from '../services/llmFacade';
import { withBusyIndicator } from '../utils/busyIndicator';
import { getYouTubeGeminiApiKey, getAudioTranscriptionApiKey } from '../services/apiKeyHelpers';
import { getPdfProviderConfig } from '../services/pdfTranslationService';
import { SummaryResultModal, type SummaryResultAction } from '../ui/modals/SummaryResultModal';

/**
 * Show summary preview modal or insert directly.
 * Returns the user's action when previewing, undefined when inserting directly.
 */
function showSummaryPreviewOrInsert(
    plugin: AIOrganiserPlugin,
    output: string,
    doInsert: () => void,
    showPreview: boolean,
    noticeMessage?: string
): Promise<SummaryResultAction> | undefined {
    if (showPreview) {
        return new Promise<SummaryResultAction>((resolve) => {
            new SummaryResultModal(plugin.app, plugin, output, (action) => {
                if (action === 'cursor') {
                    doInsert();
                    new Notice(noticeMessage || plugin.t.messages.summaryInserted);
                } else if (action === 'copy') {
                    navigator.clipboard.writeText(output);
                    new Notice(plugin.t.messages.copiedToClipboard);
                }
                resolve(action);
            }).open();
        });
    }
    doInsert();
    return undefined;
}

/**
 * Update note with structured metadata after summarization
 */
async function updateNoteMetadataAfterSummary(
    plugin: AIOrganiserPlugin,
    view: MarkdownView | MarkdownFileInfo,
    summaryHook: string,
    _suggestedTags: string[],
    _contentType: string,
    _sourceType?: SourceType,
    sourceUrl?: string,
    _personaId?: string
): Promise<void> {
    if (!plugin.settings.enableStructuredMetadata) {
        return;
    }

    const file = view.file;
    if (!file) return;

    // Build minimal metadata - just summary and source URL
    const metadata: any = {
        summary: summaryHook
    };

    // Add source URL if available (most useful reference)
    if (sourceUrl) {
        metadata.source_url = sourceUrl;
    }

    // Update frontmatter
    await updateAIOMetadata(plugin.app, file, metadata);

}

/**
 * Save transcript to a separate file in the configured transcript folder
 * Returns the path to the created file, or null if saving is disabled
 */
async function saveTranscriptToFile(
    plugin: AIOrganiserPlugin,
    transcript: string,
    sourceTitle: string,
    sourceType: 'audio' | 'youtube',
    metadata?: {
        sourcePath?: string;
        sourceUrl?: string;
        duration?: number;
        channelName?: string;
    }
): Promise<string | null> {
    // Check if transcript saving is enabled
    if (plugin.settings.saveTranscripts === 'none') {
        return null;
    }

    // Resolve full path via settings helper
    const folder = getTranscriptFullPath(plugin.settings);

    // Ensure folder hierarchy exists
    await ensureFolderExists(plugin.app.vault, folder);

    // Generate filename - sanitize the title for use as filename
    const sanitizedTitle = sourceTitle
        .replace(/[\\/:*?"<>|]/g, '-')  // Replace invalid filename chars
        .replace(/\s+/g, ' ')            // Normalize whitespace
        .trim()
        .substring(0, 100);              // Limit length

    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const fileName = `${sanitizedTitle} - ${timestamp}.md`;
    const filePath = normalizePath(`${folder}/${fileName}`);

    // Check if file already exists, add suffix if needed
    let finalPath = filePath;
    let counter = 1;
    while (plugin.app.vault.getAbstractFileByPath(finalPath)) {
        finalPath = normalizePath(`${folder}/${sanitizedTitle} - ${timestamp} (${counter}).md`);
        counter++;
    }

    // Build file content with metadata header
    let content = `# Transcript: ${sourceTitle}\n\n`;
    content += `> [!info] Metadata\n`;
    content += `> - **Type:** ${sourceType === 'youtube' ? 'YouTube Video' : 'Audio File'}\n`;
    content += `> - **Date:** ${getTodayDate()}\n`;

    if (metadata?.sourceUrl) {
        content += `> - **Source:** [${sourceTitle}](${metadata.sourceUrl})\n`;
    } else if (metadata?.sourcePath) {
        content += `> - **Source:** [[${metadata.sourcePath}]]\n`;
    }

    if (metadata?.duration) {
        content += `> - **Duration:** ${formatDuration(metadata.duration)}\n`;
    }

    if (metadata?.channelName) {
        content += `> - **Channel:** ${metadata.channelName}\n`;
    }

    content += `\n---\n\n`;
    content += `## Full Transcript\n\n`;
    content += transcript;

    // Create the file
    try {
        await plugin.app.vault.create(finalPath, content);
        return finalPath;
    } catch (error) {
        logger.error('Summary', 'Failed to save transcript:', error);
        return null;
    }
}

// getYouTubeGeminiApiKey, getAudioTranscriptionApiKey, getPdfProviderConfig
// are imported from shared modules (apiKeyHelpers.ts, pdfTranslationService.ts)

/**
 * Check if PDF summarization is available (either main provider or dedicated PDF provider)
 */
async function canSummarizePdf(plugin: AIOrganiserPlugin): Promise<boolean> {
    return (await getPdfProviderConfig(plugin)) !== null;
}

type SmartSummarizeTarget =
    | { type: 'url'; url: string }
    | { type: 'internal-pdf'; file: TFile }
    | { type: 'external-pdf'; path: string }
    | { type: 'selection-text'; text: string }
    | { type: 'none' };

/** Audio file info for both vault and external files */
interface AudioFileInfo {
    basename: string;
    path: string;
    isExternal?: boolean;
}

export function registerSummarizeCommands(plugin: AIOrganiserPlugin): void {
    const pdfService = new PdfService(plugin.app);

    // Reset privacy notice on plugin load
    resetPrivacyNotice();

    // Command: Summarize (smart dispatcher)
    // Uses callback (not editorCallback) so it works from CommandPickerModal via executeCommandById
    plugin.addCommand({
        id: 'smart-summarize',
        name: plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summarize',
        icon: 'file-text',
        callback: async () => {
            await executeSmartSummarize(plugin, pdfService);
        }
    });

    // Record Audio command (standalone)
    plugin.addCommand({
        id: 'record-audio',
        name: plugin.t.commands.recordAudio || 'Record Audio',
        icon: 'mic',
        callback: async () => {
            if (!isRecordingSupported()) {
                new Notice(plugin.t.recording?.notSupported || 'Audio recording not supported');
                return;
            }
            new AudioRecorderModal(plugin.app, plugin, { mode: 'standalone' }).open();
        }
    });
}

async function executeSmartSummarize(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService
): Promise<void> {
    if (!plugin.settings.enableWebSummarization) {
        new Notice(plugin.t.messages.webSummarizationDisabled);
        return;
    }

    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    // Get current note content for source detection
    const noteContent = view.editor.getValue();

    // Open multi-source modal with auto-detected sources
    openMultiSourceModal(plugin, pdfService, view.editor, view, noteContent);
}

/**
 * Open the multi-source summarization modal with a single source pre-filled.
 * Used by QuickPeekModal "Full Summary" button — creates PdfService internally.
 */
export function openQuickPeekFullSummary(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    sourceText: string
): void {
    const pdfService = new PdfService(plugin.app);
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice(plugin.t.messages.pleaseOpenNote);
        return;
    }
    openMultiSourceModal(plugin, pdfService, editor, view, sourceText);
}

/**
 * Open the multi-source summarization modal
 */
function openMultiSourceModal(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    view: MarkdownView,
    noteContent: string
): void {
    const modal = new MultiSourceModal(
        plugin.app,
        plugin,
        noteContent,
        async (result: MultiSourceModalResult) => {
            try {
                await handleMultiSourceResult(plugin, pdfService, editor, view, result);
            } catch (e) {
                logger.error('Summary', 'Error in handleMultiSourceResult:', e);
                new Notice(plugin.t.messages.errorGeneric.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
            }
        }
    );
    modal.open();
}

/**
 * Handle the result from multi-source modal
 * Routes to appropriate handlers based on selection
 */
async function handleMultiSourceResult(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    view: MarkdownView,
    result: MultiSourceModalResult
): Promise<void> {
    logger.debug('Summary', 'handleMultiSourceResult called with:', {
        summarizeNote: result.summarizeNote,
        urls: result.sources.urls.length,
        youtube: result.sources.youtube.length,
        pdfs: result.sources.pdfs,
        documents: result.sources.documents.length,
        audio: result.sources.audio.length,
        personaId: result.personaId
    });

    // Use persona from modal result, fallback to settings default
    const personaId = result.personaId || plugin.settings.defaultSummaryPersona;
    const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(personaId);

    // Count total sources to process
    const totalSources =
        (result.summarizeNote ? 1 : 0) +
        result.sources.urls.length +
        result.sources.youtube.length +
        result.sources.pdfs.length +
        result.sources.documents.length +
        result.sources.audio.length +
        result.sources.images.length;

    if (totalSources === 0) {
        new Notice(plugin.t.messages.noSourcesSelected);
        return;
    }

    // For single source, use existing handlers directly
    if (totalSources === 1) {
        if (result.summarizeNote) {
            await summarizeCurrentNote(plugin, editor, view, personaPrompt);
            return;
        }
        if (result.sources.urls.length === 1) {
            const url = result.sources.urls[0];
            try {
                await handleUrlSummarization(plugin, pdfService, editor, url, personaPrompt, result.focusContext, personaId);
                // Remove URL from note body after processing
                removeSourceFromEditor(editor, url);
            } catch (e) {
                logger.error('Summary', 'Error in handleUrlSummarization:', e);
                new Notice(plugin.t.messages.errorGeneric.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
            }
            return;
        }
        if (result.sources.youtube.length === 1) {
            const url = result.sources.youtube[0];
            try {
                await handleYouTubeSummarization(plugin, editor, url, personaPrompt, result.focusContext, personaId);
                // Remove YouTube URL from note body after processing
                removeSourceFromEditor(editor, url);
            } catch (e) {
                logger.error('Summary', 'Error in handleYouTubeSummarization:', e);
                new Notice(plugin.t.messages.errorGeneric.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
            }
            return;
        }
        if (result.sources.pdfs.length === 1) {
            const pdf = result.sources.pdfs[0];
            if (pdf.isVaultFile) {
                // Use Obsidian's link resolution to handle short links (just filename)
                // getFirstLinkpathDest resolves links relative to the current file
                const currentFile = view.file;
                let file = plugin.app.metadataCache.getFirstLinkpathDest(pdf.path, currentFile?.path || '');

                // Fallback to direct path lookup if link resolution fails
                if (!file) {
                    const directFile = plugin.app.vault.getAbstractFileByPath(pdf.path);
                    if (directFile instanceof TFile) {
                        file = directFile;
                    }
                }

                if (file instanceof TFile) {
                    try {
                        await handlePdfSummarization(plugin, pdfService, editor, file, personaPrompt, result.focusContext, personaId);
                    } catch (e) {
                        logger.error('Summary', 'Error in handlePdfSummarization:', e);
                        new Notice(plugin.t.messages.errorProcessingPdf.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
                    }
                } else {
                    new Notice(plugin.t.messages.couldNotFindPdfFile.replace('{path}', pdf.path));
                }
            } else {
                try {
                    await handleExternalPdfSummarization(plugin, pdfService, editor, pdf.path, personaPrompt, result.focusContext, personaId);
                } catch (e) {
                    logger.error('Summary', 'Error in handleExternalPdfSummarization:', e);
                    new Notice(plugin.t.messages.errorProcessingExternalPdf.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
                }
            }
            return;
        }
        if (result.sources.documents.length === 1) {
            const document = result.sources.documents[0];
            try {
                await handleDocumentSummarization(plugin, editor, view, document, personaPrompt, result.focusContext, personaId);
            } catch (e) {
                logger.error('Summary', 'Error in handleDocumentSummarization:', e);
                new Notice(plugin.t.messages.errorProcessingDocument.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
            }
            return;
        }
        // Single audio: fall through to multi-source path below
        // (the already-selected file is processed directly, no second picker)
    }

    // Process sources
    new Notice(plugin.t.messages.processingXSources.replace('{count}', String(totalSources)));

    const summaries: string[] = [];
    const sourceLabels: string[] = [];

    // Track source data for References and status checklist
    interface ProcessedSource {
        type: 'web' | 'youtube' | 'note' | 'pdf' | 'document' | 'audio' | 'image';
        url?: string;
        title: string;
        date: string;
        success: boolean;
        error?: string;
    }
    const allSources: ProcessedSource[] = [];
    const today = new Date().toISOString().split('T')[0];

    // Track progress
    let processedCount = 0;
    const showProgress = () => {
        new Notice(plugin.t.messages.processingSourceXofY
            .replace('{current}', String(processedCount + 1))
            .replace('{total}', String(totalSources)), 3000);
    };

    // Process note content first if selected
    if (result.summarizeNote && view.file) {
        showProgress();
        try {
            const content = await plugin.app.vault.read(view.file);
            new Notice(plugin.t.messages.summarizingNoteContent, 5000);
            const summary = await callSummarizeService(plugin, content, personaPrompt, result.focusContext);
            if (summary) {
                summaries.push(summary);
                sourceLabels.push(`Current Note: ${view.file.basename}`);
                allSources.push({
                    type: 'note',
                    title: view.file.basename,
                    date: today,
                    success: true
                });
            } else {
                allSources.push({
                    type: 'note',
                    title: view.file.basename,
                    date: today,
                    success: false,
                    error: 'Failed to generate summary'
                });
            }
            processedCount++;
        } catch (e) {
            logger.error('Summary', 'Failed to summarize note:', e);
            allSources.push({
                type: 'note',
                title: view.file.basename,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
            processedCount++;
        }
    }

    // Process URLs
    for (const url of result.sources.urls) {
        showProgress();
        try {
            new Notice(plugin.t.messages.fetchingWebPage, 5000);
            const webResult = await fetchArticle(url);
            if (webResult.success && webResult.content) {
                const title = webResult.content.title?.substring(0, 40) || 'web page';
                new Notice(plugin.t.messages.summarizingTitle.replace('{title}', title), 10000);
                const summary = await callSummarizeService(plugin, webResult.content.textContent, personaPrompt, result.focusContext);
                const fullTitle = webResult.content.title || url;
                if (summary) {
                    summaries.push(summary);
                    sourceLabels.push(`URL: ${fullTitle}`);
                    allSources.push({
                        type: 'web',
                        url: url,
                        title: title,
                        date: today,
                        success: true
                    });
                } else {
                    allSources.push({
                        type: 'web',
                        url: url,
                        title: title,
                        date: today,
                        success: false,
                        error: 'Failed to generate summary'
                    });
                }
            } else {
                allSources.push({
                    type: 'web',
                    url: url,
                    title: url,
                    date: today,
                    success: false,
                    error: webResult.error || 'Could not fetch page (may require login or JavaScript)'
                });
            }
            processedCount++;
        } catch (e) {
            logger.error('Summary', `Failed to summarize URL ${url}:`, e);
            new Notice(plugin.t.messages.failedToFetchUrl.replace('{url}', url));
            allSources.push({
                type: 'web',
                url: url,
                title: url,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Network error'
            });
            processedCount++;
        }
    }

    // Process YouTube videos using Gemini-native processing
    const youtubeGeminiKey = await getYouTubeGeminiApiKey(plugin);
    for (const url of result.sources.youtube) {
        showProgress();
        try {
            if (youtubeGeminiKey) {
                // Use Gemini-native YouTube processing (more reliable)
                new Notice(plugin.t.messages.processingYouTubeWithGemini, 5000);

                // Build prompt for YouTube summarization
                const promptOptions: SummaryPromptOptions = {
                    length: plugin.settings.summaryLength,
                    language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
                    personaPrompt: personaPrompt,
                    userContext: result.focusContext,
                };
                const prompt = buildSummaryPrompt(promptOptions);

                const geminiResult = await summarizeYouTubeWithGemini(
                    url,
                    youtubeGeminiKey,
                    prompt,
                    plugin.settings.youtubeGeminiModel,
                    plugin.settings.summarizeTimeoutSeconds * 1000
                );

                const title = geminiResult.videoInfo?.title || url;

                if (geminiResult.success && geminiResult.content) {
                    new Notice(plugin.t.messages.summarizedTitle.replace('{title}', title.substring(0, 40)), 3000);
                    summaries.push(geminiResult.content);
                    sourceLabels.push(`YouTube: ${title}`);
                    allSources.push({
                        type: 'youtube',
                        url: url,
                        title: title,
                        date: today,
                        success: true
                    });
                } else {
                    allSources.push({
                        type: 'youtube',
                        url: url,
                        title: title,
                        date: today,
                        success: false,
                        error: geminiResult.error || 'Gemini failed to process video'
                    });
                }
            } else {
                // No Gemini key - fail with helpful message
                allSources.push({
                    type: 'youtube',
                    url: url,
                    title: url,
                    date: today,
                    success: false,
                    error: 'Configure Gemini API key in Settings > YouTube to enable video processing'
                });
            }
            processedCount++;
        } catch (e) {
            logger.error('Summary', `Failed to summarize YouTube ${url}:`, e);
            new Notice(plugin.t.messages.failedToProcessYouTube.replace('{url}', url));
            allSources.push({
                type: 'youtube',
                url: url,
                title: url,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Could not process video'
            });
            processedCount++;
        }
    }

    // Process PDFs using unified workflow (handles both vault and external PDFs)
    for (const pdf of result.sources.pdfs) {
        showProgress();
        const pdfTitle = pdf.path.split('/').pop() || pdf.path;

        try {
            new Notice(plugin.t.messages.readingPdf.replace('{title}', pdfTitle), 3000);

            // Use unified PDF workflow that handles vault/external and file resolution
            const pdfResult = await summarizePdfWithFullWorkflow(
                plugin,
                pdfService,
                pdf.path,
                pdf.isVaultFile,
                {
                    personaPrompt,
                    userContext: result.focusContext,
                    currentFilePath: view.file?.path
                }
            );

            if (pdfResult.success && pdfResult.summary) {
                summaries.push(pdfResult.summary);
                sourceLabels.push(`PDF: ${pdfTitle}`);
                allSources.push({
                    type: 'pdf',
                    url: pdf.path,
                    title: pdfTitle,
                    date: today,
                    success: true
                });
            } else {
                allSources.push({
                    type: 'pdf',
                    url: pdf.path,
                    title: pdfTitle,
                    date: today,
                    success: false,
                    error: pdfResult.error || 'Failed to summarize PDF'
                });
            }
        } catch (e) {
            logger.error('Summary', 'Error processing PDF:', e);
            allSources.push({
                type: 'pdf',
                url: pdf.path,
                title: pdfTitle,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
        }

        processedCount++;
    }

    // Process Documents
    for (const document of result.sources.documents) {
        showProgress();
        const docTitle = document.path.split('/').pop() || document.path;

        try {
            const extraction = await extractDocumentTextForMultiSource(plugin, view, document);
            if (extraction.success && extraction.text) {
                new Notice(plugin.t.messages.summarizingTitle.replace('{title}', docTitle.substring(0, 40)), 5000);
                const summary = await callSummarizeService(plugin, extraction.text, personaPrompt, result.focusContext);
                if (summary) {
                    summaries.push(summary);
                    sourceLabels.push(`Document: ${docTitle}`);
                    allSources.push({
                        type: 'document',
                        url: document.path,
                        title: docTitle,
                        date: today,
                        success: true
                    });
                } else {
                    allSources.push({
                        type: 'document',
                        url: document.path,
                        title: docTitle,
                        date: today,
                        success: false,
                        error: 'Failed to generate summary'
                    });
                }
            } else {
                allSources.push({
                    type: 'document',
                    url: document.path,
                    title: docTitle,
                    date: today,
                    success: false,
                    error: extraction.error || 'Failed to extract document text'
                });
            }
        } catch (e) {
            logger.error('Summary', 'Error processing document:', e);
            allSources.push({
                type: 'document',
                url: document.path,
                title: docTitle,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
        }

        processedCount++;
    }

    // Process Audio files - transcribe and summarize
    const audioTranscriptionConfig = await getAudioTranscriptionApiKey(plugin);
    for (const audio of result.sources.audio) {
        showProgress();
        const audioTitle = audio.path.split('/').pop() || audio.path;

        // Check if we have transcription API key
        if (!audioTranscriptionConfig) {
            allSources.push({
                type: 'audio',
                url: audio.path,
                title: audioTitle,
                date: today,
                success: false,
                error: 'Audio transcription requires OpenAI or Groq API key. Configure in Settings > Audio Transcription.'
            });
            processedCount++;
            continue;
        }

        try {
            // Only vault files are supported in multi-source mode
            if (!audio.isVaultFile) {
                allSources.push({
                    type: 'audio',
                    url: audio.path,
                    title: audioTitle,
                    date: today,
                    success: false,
                    error: 'External audio files not supported in multi-source mode'
                });
                processedCount++;
                continue;
            }

            // Use Obsidian's link resolution (handles short links like [[filename.wav]])
            const currentFile = view.file;
            let audioFile = plugin.app.metadataCache.getFirstLinkpathDest(audio.path, currentFile?.path || '');

            // Fallback to direct path lookup if link resolution fails
            if (!audioFile) {
                const directFile = plugin.app.vault.getAbstractFileByPath(audio.path);
                if (directFile instanceof TFile) {
                    audioFile = directFile;
                }
            }

            if (!(audioFile instanceof TFile)) {
                allSources.push({
                    type: 'audio',
                    url: audio.path,
                    title: audioTitle,
                    date: today,
                    success: false,
                    error: 'Could not find audio file in vault'
                });
                processedCount++;
                continue;
            }

            // Use unified workflow that handles compression/chunking automatically
            const transcriptionResult = await withBusyIndicator(plugin, () =>
                transcribeAudioWithFullWorkflow(
                    plugin.app,
                    audioFile,
                    {
                        provider: audioTranscriptionConfig.provider,
                        apiKey: audioTranscriptionConfig.key,
                        language: plugin.settings.summaryLanguage || undefined
                    },
                    (progress: AudioWorkflowProgress) => {
                        // Show progress notices for key stages
                        if (progress.stage === 'compressing') {
                            new Notice(plugin.t.messages.compressingAudio || 'Compressing audio...', 2000);
                        } else if (progress.stage === 'transcribing') {
                            if (progress.totalChunks && progress.totalChunks > 1) {
                                new Notice(`Transcribing chunk ${progress.currentChunk}/${progress.totalChunks}...`, 2000);
                            } else {
                                new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...', 2000);
                            }
                        }
                    }
                )
            );

            if (!transcriptionResult.success || !transcriptionResult.transcript) {
                allSources.push({
                    type: 'audio',
                    url: audio.path,
                    title: audioTitle,
                    date: today,
                    success: false,
                    error: transcriptionResult.error || 'Failed to transcribe audio'
                });
                processedCount++;
                continue;
            }

            // Post-transcription cleanup: offer keep / compress / delete
            if (audioFile instanceof TFile) {
                const { offerPostTranscriptionCleanup } = await import('../services/audioCleanupService');
                await offerPostTranscriptionCleanup(plugin, { file: audioFile, transcriptionResult });
            }

            // Summarize the transcript
            new Notice(plugin.t.messages.summarizingTitle.replace('{title}', audioTitle.substring(0, 40)), 5000);
            const summary = await callSummarizeService(plugin, transcriptionResult.transcript, personaPrompt, result.focusContext);

            if (summary) {
                summaries.push(summary);
                sourceLabels.push(`Audio: ${audioTitle}`);
                allSources.push({
                    type: 'audio',
                    url: audio.path,
                    title: audioTitle,
                    date: today,
                    success: true
                });
            } else {
                allSources.push({
                    type: 'audio',
                    url: audio.path,
                    title: audioTitle,
                    date: today,
                    success: false,
                    error: 'Failed to generate summary from transcript'
                });
            }
        } catch (e) {
            logger.error('Summary', 'Error processing audio:', e);
            allSources.push({
                type: 'audio',
                url: audio.path,
                title: audioTitle,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
        }

        processedCount++;
    }

    // ── Images ──────────────────────────────────────────────
    if (result.sources.images.length > 0) {
        const { VisionService } = await import('../services/visionService');
        const { extractImageText } = await import('../utils/digitiseUtils');
        const visionService = new VisionService(plugin);
        const canDigitise = visionService.canDigitise();

        for (const image of result.sources.images) {
            showProgress();
            const imageTitle = image.path.split('/').pop() || image.path;

            if (!canDigitise.supported) {
                allSources.push({ type: 'image', url: image.path, title: imageTitle, date: today, success: false, error: canDigitise.reason });
                processedCount++;
                continue;
            }

            try {
                new Notice(plugin.t.messages.summarizingTitle.replace('{title}', imageTitle.substring(0, 40)), 5000);
                const extracted = await extractImageText(visionService, plugin.app, image.path, view.file?.path);
                if ('error' in extracted) {
                    allSources.push({ type: 'image', url: image.path, title: imageTitle, date: today, success: false, error: extracted.error });
                    processedCount++;
                    continue;
                }

                const summary = await callSummarizeService(plugin, extracted.text, personaPrompt, result.focusContext);
                if (summary) {
                    summaries.push(summary);
                    sourceLabels.push(`Image: ${imageTitle}`);
                    allSources.push({ type: 'image', url: image.path, title: imageTitle, date: today, success: true });
                } else {
                    allSources.push({ type: 'image', url: image.path, title: imageTitle, date: today, success: false, error: 'Failed to summarize digitised content' });
                }
            } catch (e) {
                logger.error('Summary', 'Error processing image:', e);
                allSources.push({ type: 'image', url: image.path, title: imageTitle, date: today, success: false, error: e instanceof Error ? e.message : 'Unknown error' });
            }

            processedCount++;
        }
    }

    // If no summaries but we have sources, show the status checklist
    if (summaries.length === 0) {
        if (allSources.length > 1) {
            // Build the failure status checklist
            let failureOutput = '\n\n## Summary\n\n*No content could be summarized.*\n\n### Sources Processed\n\n';
            for (const source of allSources) {
                const icon = source.success ? '✓' : '✗';
                const status = source.success ? '' : ` - *${source.error || 'Failed'}*`;
                const displayTitle = source.title.length > 60
                    ? source.title.substring(0, 57) + '...'
                    : source.title;
                failureOutput += `- [${icon}] ${displayTitle}${status}\n`;
            }
            failureOutput += '\n*0 of ' + allSources.length + ' sources processed successfully. Please try again or process sources individually.*\n';

            // Only remove successfully processed sources (preserve failed ones for retry)
            const urlsToRemove = allSources
                .filter((s: ProcessedSource) => s.url && s.type !== 'note' && s.success)
                .map((s: ProcessedSource) => s.url as string);

            const successfulFailPathUrls = new Set(urlsToRemove);
            const vaultFilePaths = [
                ...result.sources.pdfs.filter(p => p.isVaultFile && successfulFailPathUrls.has(p.path)).map(p => p.path),
                ...result.sources.audio.filter(a => a.isVaultFile && successfulFailPathUrls.has(a.path)).map(a => a.path),
                ...result.sources.documents.filter(d => d.isVaultFile && successfulFailPathUrls.has(d.path)).map(d => d.path),
            ];

            // Show preview modal — editor mutations deferred to doInsert callback
            const failureAction = await showSummaryPreviewOrInsert(plugin, failureOutput, () => {
                let fullContent = editor.getValue();
                if (urlsToRemove.length > 0 || vaultFilePaths.length > 0) {
                    fullContent = removeProcessedSources(fullContent, urlsToRemove, vaultFilePaths);
                }

                const frontmatterMatch = fullContent.match(/^---\n[\s\S]*?\n---\n?/);
                const frontmatterEnd = frontmatterMatch ? frontmatterMatch[0].length : 0;
                const frontmatter = fullContent.substring(0, frontmatterEnd);
                editor.setValue(frontmatter + failureOutput.trimStart());
            }, true, plugin.t.messages.noContentCouldBeSummarized);
            if (failureAction === 'discard') {
                new Notice(plugin.t.messages.noContentCouldBeSummarized);
            }
        } else {
            // Single source failure — just show error notice
            const error = allSources[0]?.error || 'Unknown error';
            new Notice(plugin.t.messages.errorGeneric.replace('{error}', error), 8000);
        }
        return;
    }

    // Create combined summary section
    let combinedOutput = '\n\n## Summary\n\n';

    if (summaries.length === 1) {
        combinedOutput += summaries[0];
    } else {
        // Budget guard: proportionally truncate summaries if they exceed provider limits
        const synthServiceType = plugin.settings.serviceType === 'cloud'
            ? plugin.settings.cloudServiceType
            : 'local';
        const maxSynthesisChars = getMaxContentChars(synthServiceType) - 2000; // prompt overhead
        const totalSummaryChars = summaries.reduce((sum, s) => sum + s.length, 0);

        let synthSummaries = summaries;
        if (totalSummaryChars > maxSynthesisChars && maxSynthesisChars > 0) {
            const ratio = maxSynthesisChars / totalSummaryChars;
            synthSummaries = summaries.map(s => {
                const allowedChars = Math.floor(s.length * ratio);
                return truncateAtBoundary(s, allowedChars, '\n[Summary truncated for synthesis]');
            });
        }

        // Synthesize multiple summaries
        const synthesisPrompt = buildSynthesisPrompt(synthSummaries, sourceLabels, result.focusContext, personaPrompt);
        try {
            const synthesisResult = await callSummarizeService(plugin, synthesisPrompt, '', undefined, true);
            if (synthesisResult) {
                combinedOutput += synthesisResult;
            } else {
                // Fallback: just combine with headers
                for (let i = 0; i < summaries.length; i++) {
                    combinedOutput += `### ${sourceLabels[i]}\n\n${summaries[i]}\n\n`;
                }
            }
        } catch (e) {
            logger.error('Summary', 'Failed to synthesize summaries:', e);
            // Fallback: just combine with headers
            for (let i = 0; i < summaries.length; i++) {
                combinedOutput += `### ${sourceLabels[i]}\n\n${summaries[i]}\n\n`;
            }
        }
    }

    // Add source processing status checklist if multiple sources
    if (allSources.length > 1) {
        const successCount = allSources.filter(s => s.success).length;
        const failCount = allSources.length - successCount;

        combinedOutput += '\n\n### Sources Processed\n\n';

        for (const source of allSources) {
            const icon = source.success ? '✓' : '✗';
            const status = source.success ? '' : ` - *${source.error || 'Failed'}*`;
            const displayTitle = source.title.length > 60
                ? source.title.substring(0, 57) + '...'
                : source.title;
            combinedOutput += `- [${icon}] ${displayTitle}${status}\n`;
        }

        if (failCount > 0) {
            combinedOutput += `\n*${successCount} of ${allSources.length} sources processed successfully. Failed sources may need to be added manually.*\n`;
        }
    }

    // Compute source removal data before showing preview
    const urlsToRemove = allSources
        .filter((s: ProcessedSource) => s.url && s.type !== 'note' && s.success)
        .map((s: ProcessedSource) => s.url as string);

    // Only remove vault files that were successfully processed; images stay as visual embeds
    const successfulUrls = new Set(
        allSources.filter(s => s.success && s.url).map(s => s.url!)
    );
    const vaultFilePathsList = [
        ...result.sources.pdfs.filter(p => p.isVaultFile && successfulUrls.has(p.path)).map(p => p.path),
        ...result.sources.audio.filter(a => a.isVaultFile && successfulUrls.has(a.path)).map(a => a.path),
        ...result.sources.documents.filter(d => d.isVaultFile && successfulUrls.has(d.path)).map(d => d.path),
        // Images are NOT removed — they remain useful as visual embeds
    ];
    const vaultFilePaths = new Set<string>(vaultFilePathsList);

    // Show preview modal — all editor mutations deferred to doInsert callback
    await showSummaryPreviewOrInsert(plugin, combinedOutput, () => {
        // 1. Remove processed sources
        let fullContent = editor.getValue();
        if (urlsToRemove.length > 0 || vaultFilePathsList.length > 0) {
            fullContent = removeProcessedSources(fullContent, urlsToRemove, vaultFilePathsList);
        }

        // 2. Replace body with summary (after frontmatter)
        const frontmatterMatch = fullContent.match(/^---\n[\s\S]*?\n---\n?/);
        const frontmatterEnd = frontmatterMatch ? frontmatterMatch[0].length : 0;
        const frontmatter = fullContent.substring(0, frontmatterEnd);
        editor.setValue(frontmatter + combinedOutput.trimStart());

        // 3. Add references for successful sources
        for (const source of allSources) {
            if (source.url && source.success) {
                const refType =
                    source.type === 'web' ? 'web' as const :
                    source.type === 'youtube' ? 'youtube' as const :
                    source.type === 'pdf' ? 'pdf' as const :
                    source.type === 'audio' ? 'audio' as const :
                    source.type === 'document' ? 'document' as const :
                    source.type === 'image' ? 'image' as const :
                    'note' as const;
                const isInternal = vaultFilePaths.has(source.url);
                const sourceRef: SourceReference = {
                    type: refType,
                    title: source.title,
                    link: source.url,
                    date: source.date,
                    isInternal
                };
                addToReferencesSection(editor, sourceRef);
            }
        }

        // 4. Ensure note structure
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    }, true, `Summarized ${summaries.length} source(s)`);
}

/**
 * Remove a single source URL from the editor content
 * Used after processing to move URLs to References section
 */
function removeSourceFromEditor(editor: Editor, url: string): void {
    const fullContent = editor.getValue();
    const cleanedContent = removeProcessedSources(fullContent, [url]);
    if (cleanedContent !== fullContent) {
        const cursor = editor.getCursor();
        editor.setValue(cleanedContent);
        // Clamp cursor to document bounds — content removal may shorten the document
        const lastLine = editor.lastLine();
        const clampedLine = Math.min(cursor.line, lastLine);
        const lineLength = editor.getLine(clampedLine).length;
        editor.setCursor({ line: clampedLine, ch: Math.min(cursor.ch, lineLength) });
    }
}

/**
 * Call the summarize service to get a summary
 */
async function callSummarizeService(
    plugin: AIOrganiserPlugin,
    content: string,
    personaPrompt: string,
    focusContext?: string,
    isRawPrompt: boolean = false
): Promise<string | null> {
    try {
        let finalPrompt: string;

        if (isRawPrompt) {
            // Content is already a complete prompt
            finalPrompt = content;
        } else {
            const language = getLanguageNameForPrompt(plugin.settings.summaryLanguage);
            const promptOptions: SummaryPromptOptions = {
                length: plugin.settings.summaryLength,
                language,
                personaPrompt,
                userContext: focusContext
            };
            const prompt = buildSummaryPrompt(promptOptions);
            finalPrompt = insertContentIntoPrompt(prompt, content);
        }

        const response = await withBusyIndicator(plugin, () => summarizeText(pluginContext(plugin), finalPrompt));
        return response.success ? response.content || null : null;
    } catch (e) {
        logger.error('Summary', 'Failed to summarize content:', e);
        return null;
    }
}

/**
 * Build a prompt to synthesize multiple summaries
 */
function buildSynthesisPrompt(
    summaries: string[],
    sourceLabels: string[],
    focusContext: string | undefined,
    personaPrompt: string
): string {
    let prompt = `<task>
Synthesize the following ${summaries.length} summaries into a single, coherent summary.
Combine related information, eliminate redundancy, and organize the content logically.
${focusContext ? `Focus on: ${focusContext}` : ''}
</task>

${personaPrompt ? `<persona>${personaPrompt}</persona>` : ''}

<summaries>
`;

    for (let i = 0; i < summaries.length; i++) {
        prompt += `\n### Source: ${sourceLabels[i]}\n${summaries[i]}\n`;
    }

    prompt += `</summaries>

<output_format>
Provide a unified summary that:
1. Integrates key points from all sources
2. Highlights common themes and connections
3. Notes any contrasting perspectives
4. Is well-structured with clear organization
</output_format>`;

    return prompt;
}

async function handleSmartTarget(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    target: SmartSummarizeTarget,
    personaPrompt: string,
    personaId?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    if (target.type === 'selection-text') {
        await handleTextSummarization(plugin, editor, target.text, personaPrompt);
        return;
    }

    if (target.type === 'url') {
        if (isYouTubeUrl(target.url)) {
            await handleYouTubeSummarization(plugin, editor, target.url, personaPrompt, undefined, personaId);
            return;
        }
        await handleUrlSummarization(plugin, pdfService, editor, target.url, personaPrompt, undefined, personaId);
        return;
    }

    if (target.type === 'internal-pdf') {
        if (!canSummarizePdf(plugin)) {
            new Notice(plugin.t.settings.pdf?.noProviderConfigured || plugin.t.messages.pdfNotSupported);
            return;
        }
        await handlePdfSummarization(plugin, pdfService, editor, target.file, personaPrompt, undefined, personaId);
        return;
    }

    if (target.type === 'external-pdf') {
        if (Platform.isMobile) {
            new Notice(plugin.t.messages.externalFilesDesktopOnly || 'External files are desktop-only');
            return;
        }
        if (!canSummarizePdf(plugin)) {
            new Notice(plugin.t.settings.pdf?.noProviderConfigured || plugin.t.messages.pdfNotSupported);
            return;
        }
        await handleExternalPdfSummarization(plugin, pdfService, editor, target.path, personaPrompt, undefined, personaId);
        return;
    }
}

function openSummarizeSourceModal(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    view: MarkdownView,
    detectedSource?: SummarizeSourceOption
): void {
    const modal = new SummarizeSourceModal(plugin.app, plugin, async (source: SummarizeSourceOption) => {
        const defaultPersonaId = plugin.settings.defaultSummaryPersona;
        const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(defaultPersonaId);

        switch (source) {
            case 'note':
                void summarizeCurrentNote(plugin, editor, view, personaPrompt);
                break;
            case 'url':
                void openUrlSummarizeModal(plugin, pdfService, editor);
                break;
            case 'pdf':
                void openPdfSummarizeModal(plugin, pdfService, editor, view);
                break;
            case 'youtube':
                void openYouTubeSummarizeModal(plugin, editor);
                break;
            case 'audio':
                void openAudioSummarizeModal(plugin, editor);
                break;
            default:
                break;
        }
    }, detectedSource);
    modal.open();
}

async function summarizeCurrentNote(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView,
    personaPrompt: string
): Promise<void> {
    if (!view.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const content = await plugin.app.vault.read(view.file);
    if (!content.trim()) {
        new Notice(plugin.t.messages.noContent);
        return;
    }

    await handleTextSummarization(plugin, editor, content, personaPrompt);
}

async function openUrlSummarizeModal(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor
): Promise<void> {
    const personas = await plugin.configService.getSummaryPersonas();
    const modal = new UrlInputModal(
        plugin.app,
        plugin.t,
        plugin.settings.defaultSummaryPersona,
        personas,
        plugin.settings.enableStudyCompanion,
        async (result) => {
            const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(result.personaId);
            await handleUrlSummarization(plugin, pdfService, editor, result.url, personaPrompt, result.context, result.personaId);
        }
    );
    modal.open();
}

async function openPdfSummarizeModal(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    view: MarkdownView
): Promise<void> {
    if (!canSummarizePdf(plugin)) {
        new Notice(plugin.t.settings.pdf?.noProviderConfigured || plugin.t.messages.pdfNotSupported);
        return;
    }

    const defaultPersona = plugin.settings.defaultSummaryPersona;
    const personas = await plugin.configService.getSummaryPersonas();
    const currentFile = view.file;

    const embeddedPdfs: TFile[] = [];
    if (currentFile) {
        const content = await plugin.app.vault.read(currentFile);
        const pdfLinks = findEmbeddedPdfLinks(content);
        logger.debug('Summary', 'Current file:', currentFile.path);
        logger.debug('Summary', 'Found PDF links in note:', pdfLinks);
        for (const linkPath of pdfLinks) {
            const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, currentFile.path);
            logger.debug('Summary', `Resolving link: ${linkPath} -> resolved: ${resolved?.path || 'null'}`);
            if (resolved instanceof TFile && resolved.extension === 'pdf') {
                embeddedPdfs.push(resolved);
            }
        }
        logger.debug('Summary', 'Embedded PDFs found:', embeddedPdfs.map(f => f.path));
    }

    let pdfs = await pdfService.getPdfsInAttachments();
    if (pdfs.length === 0) {
        pdfs = pdfService.getAllPdfs();
    }

    if (pdfs.length === 0 && embeddedPdfs.length === 0) {
        new Notice(plugin.t.messages.noPdfsFound);
        return;
    }

    const embeddedPaths = new Set(embeddedPdfs.map(f => f.path));
    const otherPdfs = pdfs.filter(f => !embeddedPaths.has(f.path));
    const orderedPdfs = [...embeddedPdfs, ...otherPdfs];

    const modal = new PdfSelectModal(
        plugin.app,
        plugin.t,
        orderedPdfs,
        defaultPersona,
        personas,
        plugin.settings.enableStudyCompanion,
        async (result) => {
            if (result.file) {
                const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(result.personaId);
                await handlePdfSummarization(plugin, pdfService, editor, result.file, personaPrompt, result.context, result.personaId);
            }
        },
        async (result) => {
            const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(result.personaId);
            await handleExternalPdfSummarization(plugin, pdfService, editor, result.externalPath, personaPrompt, result.context, result.personaId);
        }
    );
    modal.open();
}

async function openYouTubeSummarizeModal(
    plugin: AIOrganiserPlugin,
    editor: Editor
): Promise<void> {
    const personas = await plugin.configService.getSummaryPersonas();
    const modal = new YouTubeInputModal(
        plugin.app,
        plugin.t,
        plugin.settings.defaultSummaryPersona,
        personas,
        plugin.settings.enableStudyCompanion,
        async (result) => {
            const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(result.personaId);
            await handleYouTubeSummarization(plugin, editor, result.url, personaPrompt, result.context, result.personaId);
        }
    );
    modal.open();
}

async function openAudioSummarizeModal(
    plugin: AIOrganiserPlugin,
    editor: Editor
): Promise<void> {
    // Use the new helper that checks dedicated key, main provider, and provider settings
    const transcriptionConfig = await getAudioTranscriptionApiKey(plugin);

    if (!transcriptionConfig) {
        new Notice(
            plugin.t.settings.audioTranscription?.noKeyWarning ||
            'Audio transcription requires OpenAI or Groq API key. Configure in Settings > Audio Transcription.'
        );
        return;
    }

    const personas = await plugin.configService.getSummaryPersonas();
    const modal = new AudioSelectModal(
        plugin.app,
        plugin.t,
        plugin.settings.defaultSummaryPersona,
        personas,
        plugin.settings.enableStudyCompanion,
        async (result: AudioSelectResult) => {
            await handleAudioSummarization(plugin, editor, result, transcriptionConfig.provider, transcriptionConfig.key);
        }
    );
    modal.open();
}

function detectTargetFromFrontmatter(
    plugin: AIOrganiserPlugin,
    file: TFile
): SmartSummarizeTarget {
    const cache = plugin.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};

    const pdfValue = normalizeFrontmatterValue(frontmatter.pdf);
    if (pdfValue) {
        const target = detectTargetFromText(plugin, pdfValue, file, false);
        if (target.type !== 'none') {
            return target;
        }
    }

    const urlValue = normalizeFrontmatterValue(frontmatter.url);
    if (urlValue) {
        return { type: 'url', url: urlValue };
    }

    return { type: 'none' };
}

function normalizeFrontmatterValue(value: unknown): string | null {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        const first = value.find(item => typeof item === 'string');
        return typeof first === 'string' ? first.trim() : null;
    }
    return null;
}

function detectTargetFromText(
    plugin: AIOrganiserPlugin,
    text: string,
    currentFile: TFile,
    allowText: boolean
): SmartSummarizeTarget {
    const trimmed = text.trim();
    if (!trimmed) {
        return { type: 'none' };
    }

    const externalPdfPath = extractExternalPdfPath(trimmed);
    if (externalPdfPath) {
        return { type: 'external-pdf', path: externalPdfPath };
    }

    const internalPdf = extractInternalPdfFile(plugin, trimmed, currentFile);
    if (internalPdf) {
        return { type: 'internal-pdf', file: internalPdf };
    }

    const url = extractUrl(trimmed);
    if (url) {
        return { type: 'url', url };
    }

    if (allowText) {
        return { type: 'selection-text', text: trimmed };
    }

    return { type: 'none' };
}

function extractInternalPdfFile(
    plugin: AIOrganiserPlugin,
    text: string,
    currentFile: TFile
): TFile | null {
    const wikiLinkRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const matches = [...text.matchAll(wikiLinkRegex)];

    for (const match of matches) {
        const rawPath = match[1] || match[2];
        if (!rawPath) continue;
        const trimmedPath = rawPath.trim();
        if (!trimmedPath.toLowerCase().endsWith('.pdf')) {
            continue;
        }
        const resolved = plugin.app.metadataCache.getFirstLinkpathDest(trimmedPath, currentFile.path);
        if (resolved instanceof TFile && resolved.extension === 'pdf') {
            return resolved;
        }
    }

    if (text.toLowerCase().endsWith('.pdf')) {
        const resolved = plugin.app.metadataCache.getFirstLinkpathDest(text, currentFile.path);
        if (resolved instanceof TFile && resolved.extension === 'pdf') {
            return resolved;
        }
    }

    return null;
}

/**
 * Find all embedded PDF links in note content
 * Returns array of link paths (without resolved TFiles)
 */
function findEmbeddedPdfLinks(content: string): string[] {
    const pdfLinks: string[] = [];
    // Match both ![[file.pdf]] and [[file.pdf]] patterns
    const wikiLinkRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const matches = [...content.matchAll(wikiLinkRegex)];

    for (const match of matches) {
        const rawPath = match[1] || match[2];
        if (!rawPath) continue;
        const trimmedPath = rawPath.trim();
        if (trimmedPath.toLowerCase().endsWith('.pdf')) {
            pdfLinks.push(trimmedPath);
        }
    }

    return pdfLinks;
}

function extractExternalPdfPath(text: string): string | null {
    const fileUrlMatch = text.match(/file:\/\/\/[^\s)\]]+/i);
    if (fileUrlMatch && fileUrlMatch[0].toLowerCase().includes('.pdf')) {
        return trimTrailingPunctuation(fileUrlMatch[0]);
    }

    const windowsPathMatch = text.match(/[a-zA-Z]:[\\/][^\s)\]]+\.pdf/i);
    if (windowsPathMatch) {
        return trimTrailingPunctuation(windowsPathMatch[0]);
    }

    const unixPathRegex = /\/[^\s)\]]+\.pdf/gi;
    for (const match of text.matchAll(unixPathRegex)) {
        const prefix = text.slice(0, match.index);
        if (prefix.endsWith('http:') || prefix.endsWith('https:')) {
            continue;
        }
        return trimTrailingPunctuation(match[0]);
    }

    return null;
}

function extractUrl(text: string): string | null {
    const markdownLinkMatch = text.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/i);
    if (markdownLinkMatch) {
        return trimTrailingPunctuation(markdownLinkMatch[1]);
    }

    const urlMatch = text.match(/https?:\/\/[^\s)\]]+/i);
    if (urlMatch) {
        return trimTrailingPunctuation(urlMatch[0]);
    }

    return null;
}

function trimTrailingPunctuation(value: string): string {
    return value.replace(/[.,;:!?]+$/, '');
}

/**
 * Handle URL summarization with privacy notice, content size handling, and chunking
 */
async function handleUrlSummarization(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    url: string,
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    // Check if URL is a direct PDF link
    if (isPdfUrl(url)) {
        new Notice(plugin.t.messages.savingPdfFromUrl);

        // Try to download and save PDF
        const fileName = extractFilenameFromUrl(url) || `downloaded-${Date.now()}.pdf`;
        const pdfFile = await pdfService.downloadPdfToVault(url, fileName);

        if (pdfFile && await canSummarizePdf(plugin)) {
            await handlePdfSummarization(plugin, pdfService, editor, pdfFile, personaPrompt);
            return;
        } else if (!await canSummarizePdf(plugin)) {
            new Notice(plugin.t.settings.pdf?.noProviderConfigured || plugin.t.messages.pdfNotSupported);
            return;
        } else {
            new Notice('Failed to download PDF');
            openInBrowser(url);
            return;
        }
    }

    new Notice(plugin.t.messages.fetchingUrl);

    const result = await fetchArticle(url);

    logger.debug('Summary', 'URL fetch result:', {
        success: result.success,
        error: result.error,
        hasContent: !!result.content,
        contentLength: result.content?.content?.length || 0,
        textContentLength: result.content?.textContent?.length || 0,
        title: result.content?.title
    });

    if (result.success && result.content) {
        // Show progress - summarization can take a while for large content
        const contentSize = result.content.textContent?.length || 0;
        const sizeDesc = contentSize > 15000 ? 'large article' : contentSize > 5000 ? 'article' : 'content';
        new Notice(`Summarizing ${sizeDesc} (${Math.round(contentSize / 1000)}k chars)... This may take a moment.`, 15000);

        // Check content size against limits
        const content = result.content.content; // Markdown content
        const maxChars = getMaxContentChars(serviceType);

        logger.debug('Summary', 'Content to summarize:', {
            length: content.length,
            preview: content.substring(0, 500)
        });

        if (isContentTooLarge(content, serviceType)) {
            // Show content size modal for user choice
            const choice = await showContentSizeModal(plugin, content.length, maxChars);

            if (choice === 'cancel') {
                return;
            } else if (choice === 'truncate') {
                const truncatedContent = truncateContent(content, serviceType);
                await summarizeAndInsert(plugin, editor, truncatedContent, result.content, personaPrompt, userContext, personaId);
                new Notice(plugin.t.messages.contentTruncated);
            } else if (choice === 'chunk') {
                await summarizeInChunks(plugin, editor, content, result.content, serviceType, personaPrompt, userContext);
            }
        } else {
            await summarizeAndInsert(plugin, editor, content, result.content, personaPrompt, userContext, personaId);
        }

    } else if (result.requiresPdfFallback) {
        // Offer PDF fallback
        new Notice(plugin.t.messages.fetchFailed + ' ' + plugin.t.messages.openingBrowser);
        openInBrowser(url);

        // Show instructions for longer time
        new Notice(plugin.t.messages.pdfInstructions, 10000);

    } else {
        new Notice(`Error: ${result.error}`);
    }
}

/**
 * Handle plain text summarization (selection)
 */
async function handleTextSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    text: string,
    personaPrompt: string,
    userContext?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    const maxChars = getMaxContentChars(serviceType);

    if (isContentTooLarge(text, serviceType)) {
        const choice = await showContentSizeModal(plugin, text.length, maxChars);

        if (choice === 'cancel') {
            return;
        } else if (choice === 'truncate') {
            const truncatedContent = truncateContent(text, serviceType);
            await summarizePlainTextAndInsert(plugin, editor, truncatedContent, personaPrompt, userContext);
            new Notice(plugin.t.messages.contentTruncated);
        } else if (choice === 'chunk') {
            await summarizePlainTextInChunks(plugin, editor, text, serviceType, personaPrompt, userContext);
        }
    } else {
        await summarizePlainTextAndInsert(plugin, editor, text, personaPrompt, userContext);
    }
}

/**
 * Handle PDF summarization
 */
async function handlePdfSummarization(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    file: TFile,
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.readingPdf);

    // LLM work — wrapped with busy indicator
    const result = await withBusyIndicator(plugin, () => summarizePdfWithFullWorkflow(
        plugin,
        pdfService,
        file.path,
        true, // isVaultFile
        { personaPrompt, userContext }
    ));

    if (!result.success || !result.summary || !result.pdfContent) {
        new Notice(result.error || 'Failed to summarize PDF');
        return;
    }

    // Preview modal + metadata — outside busy indicator
    const action = await insertPdfSummary(editor, result.summary, result.pdfContent, plugin, true, true);

    // Only skip metadata if user actively chose NOT to insert (copy/discard)
    if (action && action !== 'cursor') return;

    // Update metadata if structured metadata is enabled
    if (plugin.settings.enableStructuredMetadata && personaId) {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            await updateNoteMetadataAfterSummary(
                plugin,
                view,
                createSummaryHook(result.summary),
                [],
                'reference',
                'pdf',
                result.pdfContent.filePath,
                personaId
            );
        }
    }
}

/**
 * Handle external PDF summarization (outside vault)
 */
async function handleExternalPdfSummarization(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    filePath: string,
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.readingPdf);

    // LLM work — wrapped with busy indicator
    const result = await withBusyIndicator(plugin, () => summarizePdfWithFullWorkflow(
        plugin,
        pdfService,
        filePath,
        false, // isVaultFile (external)
        { personaPrompt, userContext }
    ));

    if (!result.success || !result.summary || !result.pdfContent) {
        new Notice(result.error || 'Failed to summarize PDF');
        return;
    }

    // Preview modal + metadata — outside busy indicator
    const action = await insertPdfSummary(editor, result.summary, result.pdfContent, plugin, false, true);

    // Only skip metadata if user actively chose NOT to insert (copy/discard)
    if (action && action !== 'cursor') return;

    // Update metadata if structured metadata is enabled
    if (plugin.settings.enableStructuredMetadata && personaId) {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            await updateNoteMetadataAfterSummary(
                plugin,
                view,
                createSummaryHook(result.summary),
                [],
                'reference',
                'pdf',
                result.pdfContent.filePath,
                personaId
            );
        }
    }
}

/**
 * Handle document summarization (docx/xlsx/pptx/txt/rtf)
 */
async function handleDocumentSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView,
    document: { path: string; isVaultFile: boolean },
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const result = await extractDocumentTextForMultiSource(plugin, view, document);
    if (!result.success || !result.text) {
        new Notice(result.error || 'Failed to extract document text');
        return;
    }

    await summarizePlainTextAndInsert(plugin, editor, result.text, personaPrompt, userContext);
}

async function extractDocumentTextForMultiSource(
    plugin: AIOrganiserPlugin,
    view: MarkdownView,
    document: { path: string; isVaultFile: boolean }
): Promise<{ success: boolean; text?: string; error?: string }> {
    const documentService = new DocumentExtractionService(plugin.app);

    if (document.isVaultFile) {
        const currentFile = view.file;
        let file = plugin.app.metadataCache.getFirstLinkpathDest(document.path, currentFile?.path || '');

        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(document.path);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }

        if (!file) {
            return { success: false, error: 'Document file not found in vault' };
        }

        const result = await documentService.extractText(file);
        if (!result.success || !result.text) {
            return { success: false, error: result.error || 'Failed to extract document text' };
        }

        const text = await applyMultiSourceTruncation(plugin, result.text, file.basename);
        return { success: true, text };
    }

    const progressNotice = (status: string) => {
        const t = plugin.t.minutes;
        const message = status.startsWith('Downloading')
            ? (t?.downloadingDocument || status)
            : (t?.extractingText || status);
        new Notice(message, 2000);
    };
    const result = await documentService.extractFromUrl(document.path, progressNotice);
    if (!result.success || !result.text) {
        return { success: false, error: result.error || 'Failed to extract document from URL' };
    }

    const title = document.path.split('/').pop() || document.path;
    const text = await applyMultiSourceTruncation(plugin, result.text, title);
    return { success: true, text };
}

async function applyMultiSourceTruncation(
    plugin: AIOrganiserPlugin,
    text: string,
    title: string
): Promise<string> {
    const maxChars = plugin.settings.multiSourceMaxDocumentChars || DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS;
    const behavior = plugin.settings.multiSourceOversizedBehavior || 'full';

    if (text.length <= maxChars) return text;

    if (behavior === 'full') {
        return text;
    }

    if (behavior === 'truncate') {
        return truncateAtBoundary(text, maxChars, '\n\n[Truncated...]');
    }

    const confirmMessage = `Document "${title}" is ${text.length} chars (limit ${maxChars}). Use full content?`;
    const useFull = await plugin.showConfirmationDialog(confirmMessage);
    return useFull ? text : truncateAtBoundary(text, maxChars, '\n\n[Truncated...]');
}

/**
 * Handle audio file transcription and summarization
 */
async function handleAudioSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    result: AudioSelectResult,
    provider: 'openai' | 'groq',
    apiKey: string
): Promise<void> {
    const { file, externalPath, language, context, needsCompression } = result;
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';
    const mobileWarningThresholdMb = 10;

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    let transcriptionResult;
    let audioName: string;
    let audioPath: string;

    // Handle external file (outside vault)
    if (externalPath) {
        if (Platform.isMobile) {
            new Notice(plugin.t.messages.mobileExternalNotSupported);
            return;
        }
        const path = require('path');
        audioName = path.basename(externalPath, path.extname(externalPath));
        audioPath = externalPath;

        // External files: compression not yet supported, transcribe directly
        if (needsCompression) {
            new Notice(plugin.t.messages.externalCompressionNotSupported ||
                'Compression for external files not yet supported. Please use a smaller file or compress it externally.');
            return;
        }

        new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');

        transcriptionResult = await transcribeExternalAudio(externalPath, {
            provider,
            apiKey,
            language: language || plugin.settings.summaryLanguage || undefined,
            prompt: context || undefined
        });
    } else if (file) {
        // Mobile data warning for large files
        if (Platform.isMobile && file.stat?.size) {
            const sizeMb = Math.ceil(file.stat.size / (1024 * 1024));
            if (sizeMb >= mobileWarningThresholdMb) {
                const proceed = await plugin.showConfirmationDialog(
                    plugin.t.messages.mobileDataWarning.replace('{size}', String(sizeMb))
                );
                if (!proceed) {
                    return;
                }
            }
        }

        // Handle vault file
        audioName = file.basename;
        audioPath = file.path;

        // Use unified workflow that handles compression/chunking automatically
        transcriptionResult = await withBusyIndicator(plugin, () =>
            transcribeAudioWithFullWorkflow(
                plugin.app,
                file,
                {
                    provider,
                    apiKey,
                    language: language || plugin.settings.summaryLanguage || undefined,
                    prompt: context || undefined
                },
                (progress: AudioWorkflowProgress) => {
                    logger.debug('Summary', 'Audio workflow progress:', progress);
                    // Show progress notices for key stages
                    if (progress.stage === 'checking') {
                        // Silent - no notice needed
                    } else if (progress.stage === 'compressing') {
                        if (progress.progress % 25 === 0 || progress.progress === 5) {
                            new Notice(`Compressing: ${progress.progress}%`);
                        }
                    } else if (progress.stage === 'chunking') {
                        new Notice(progress.message);
                    } else if (progress.stage === 'transcribing') {
                        if (progress.totalChunks && progress.totalChunks > 1) {
                            // Only show every 3rd chunk or first/last
                            if (progress.currentChunk === 1 ||
                                progress.currentChunk === progress.totalChunks ||
                                (progress.currentChunk && progress.currentChunk % 3 === 0)) {
                                new Notice(`Transcribing chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.progress}%)`);
                            }
                        } else {
                            new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');
                        }
                    } else if (progress.stage === 'error') {
                        new Notice(progress.message);
                    }
                }
            )
        );

        // Handle transcription failure
        if (!transcriptionResult.success) {
            new Notice(
                (plugin.t.messages.transcriptionFailed || 'Transcription failed') +
                `: ${transcriptionResult.error || 'Unknown error'}`
            );
            return;
        }
    } else {
        new Notice('No audio file selected');
        return;
    }

    logger.debug('Summary', 'Transcription result:', transcriptionResult);

    if (!transcriptionResult.success || !transcriptionResult.transcript) {
        new Notice(
            (plugin.t.messages.transcriptionFailed || 'Transcription failed') +
            `: ${transcriptionResult.error || 'Unknown error'}`
        );
        return;
    }

    const transcript = transcriptionResult.transcript;

    logger.debug('Summary', 'Transcript received, length:', transcript.length);

    // Save transcript to file if enabled
    const transcriptPath = await saveTranscriptToFile(
        plugin,
        transcript,
        audioName,
        'audio',
        {
            sourcePath: audioPath,
            duration: transcriptionResult.duration
        }
    );

    if (transcriptPath) {
        logger.debug('Summary', 'Transcript saved to:', transcriptPath);
    }

    // Post-transcription cleanup: offer keep / compress / delete
    if (file) {
        const { offerPostTranscriptionCleanup } = await import('../services/audioCleanupService');
        await offerPostTranscriptionCleanup(plugin, { file, transcriptionResult });
    }

    // Now summarize the transcript
    new Notice(plugin.t.messages.summarizingTranscript || 'Summarizing transcript...');

    // Check content size against limits
    const maxChars = getMaxContentChars(serviceType);

    // Create a file-like object for external files to pass to summary functions
    const audioFileInfo = {
        basename: audioName,
        path: audioPath,
        isExternal: !!externalPath
    };

    if (isContentTooLarge(transcript, serviceType)) {
        // Show content size modal for user choice
        const choice = await showContentSizeModal(plugin, transcript.length, maxChars);

        if (choice === 'cancel') {
            return;
        } else if (choice === 'truncate') {
            const truncatedContent = truncateContent(transcript, serviceType);
            await summarizeAudioAndInsert(plugin, editor, truncatedContent, audioFileInfo, transcriptionResult.duration, undefined, transcriptPath);
            new Notice(plugin.t.messages.contentTruncated);
        } else if (choice === 'chunk') {
            await summarizeAudioInChunks(plugin, editor, transcript, audioFileInfo, serviceType, transcriptionResult.duration, transcriptPath);
        }
    } else {
        await summarizeAudioAndInsert(plugin, editor, transcript, audioFileInfo, transcriptionResult.duration, undefined, transcriptPath);
    }
}

/**
 * Summarize audio transcript and insert into editor
 */
async function summarizeAudioAndInsert(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    file: AudioFileInfo,
    duration?: number,
    personaPrompt?: string,
    transcriptPath?: string | null
): Promise<void> {
    logger.debug('Summary', 'Transcript length:', transcript.length);
    logger.debug('Summary', 'Transcript preview:', transcript.substring(0, 500));

    // Get persona prompt if not provided
    const actualPersonaPrompt = personaPrompt || await plugin.configService.getSummaryPersonaPrompt(plugin.settings.defaultSummaryPersona);

    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: actualPersonaPrompt,
    };

    const promptTemplate = buildSummaryPrompt(promptOptions);
    const prompt = insertContentIntoPrompt(promptTemplate, transcript);

    logger.debug('Summary', 'Summary prompt length:', prompt.length);

    try {
        const response = await withBusyIndicator(plugin, () => summarizeTextWithLLM(plugin, prompt));

        logger.debug('Summary', 'Summary response:', response);

        if (response.success && response.content) {
            await insertAudioSummary(editor, response.content, file, duration, plugin, transcriptPath, true);
        } else {
            new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
            await insertAudioSummary(editor, `[Summarization failed: ${response.error || 'No content returned'}]`, file, duration, plugin, transcriptPath);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing: ${errorMessage}`);
        await insertAudioSummary(editor, `[Error: ${errorMessage}]`, file, duration, plugin, transcriptPath);
    }
}

/**
 * Shared chunked summarization: map phase (per-chunk) → reduce phase (combine).
 * Returns the combined summary string. Callers handle insertion and metadata.
 */
async function summarizeContentInChunks(
    plugin: AIOrganiserPlugin,
    content: string,
    provider: string,
    personaPrompt: string,
    userContext?: string,
    includeCompanion?: boolean
): Promise<string> {
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);
    const chunks = chunkContent(content, maxChunkChars);
    const chunkSummaries: string[] = [];

    // Map phase
    for (let i = 0; i < chunks.length; i++) {
        new Notice(
            plugin.t.messages.summarizingChunk
                .replace('{current}', String(i + 1))
                .replace('{total}', String(chunks.length))
        );

        const promptOptions: SummaryPromptOptions = {
            length: 'detailed',
            language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
            personaPrompt,
            userContext,
            chunkIndex: i + 1,
            chunkTotal: chunks.length,
        };

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, chunks[i]);

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);
            chunkSummaries.push(
                response.success && response.content
                    ? response.content
                    : `[Error summarizing section ${i + 1}]`
            );
        } catch {
            chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
        }
    }

    // Reduce phase
    new Notice(plugin.t.messages.combiningChunks);

    const combineOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt,
        userContext,
        includeCompanion,
    };

    const combineTemplate = buildChunkCombinePrompt(combineOptions);
    const combinePrompt = insertSectionsIntoPrompt(combineTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);
        return response.success && response.content
            ? response.content
            : chunkSummaries.join('\n\n');
    } catch {
        return chunkSummaries.join('\n\n');
    }
}

/**
 * Summarize audio transcript in chunks
 */
async function summarizeAudioInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    file: AudioFileInfo,
    provider: string,
    duration?: number,
    transcriptPath?: string | null
): Promise<void> {
    const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(plugin.settings.defaultSummaryPersona);

    const { finalContent } = await withBusyIndicator(plugin, async () => {
        const result = await summarizeContentInChunks(plugin, transcript, provider, personaPrompt);
        return { finalContent: result };
    });

    await insertAudioSummary(editor, finalContent, file, duration, plugin, transcriptPath, true);
}

/**
 * Insert audio summary into editor with metadata
 * Adds source to References section
 */
async function insertAudioSummary(
    editor: Editor,
    summary: string,
    file: AudioFileInfo,
    duration: number | undefined,
    plugin: AIOrganiserPlugin,
    transcriptPath?: string | null,
    showPreview: boolean = false
): Promise<SummaryResultAction | undefined> {
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${file.basename}\n\n`;
    }

    output += summary;

    // Add transcript link if available
    if (transcriptPath) {
        output += `\n\n> [!note] Full Transcript\n> [[${transcriptPath}|View full transcript]]\n`;
    }

    const doInsert = () => {
        const cursor = editor.getCursor();
        editor.replaceRange(output, cursor);

        const sourceRef: SourceReference = {
            type: 'audio',
            title: file.basename,
            link: file.path,
            date: getTodayDate(),
            duration: duration ? formatDuration(duration) : undefined,
            isInternal: true
        };
        addToReferencesSection(editor, sourceRef);
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    };

    return showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview);
}

/**
 * Handle YouTube video summarization
 */
async function handleYouTubeSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    url: string,
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    // Validate YouTube URL
    if (!isYouTubeUrl(url)) {
        new Notice(plugin.t.messages.invalidYouTubeUrl || 'Invalid YouTube URL');
        return;
    }

    // Check for Gemini API key
    const geminiKey = await getYouTubeGeminiApiKey(plugin);
    if (!geminiKey) {
        new Notice(plugin.t.settings.youtube?.noKeyWarning || 'Configure Gemini API key in Settings > YouTube to enable video processing');
        return;
    }

    // Privacy notice for Gemini (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, 'gemini');
        if (!proceed) return;
    }

    new Notice('Processing YouTube video with Gemini...', 5000);

    // Build prompt for YouTube summarization
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };
    const prompt = buildSummaryPrompt(promptOptions);

    try {
        const result = await summarizeYouTubeWithGemini(
            url,
            geminiKey,
            prompt,
            plugin.settings.youtubeGeminiModel,
            plugin.settings.summarizeTimeoutSeconds * 1000
        );

        if (!result.success || !result.content) {
            new Notice(result.error || 'Failed to process YouTube video');
            return;
        }

        const videoInfo = result.videoInfo;
        const summary = result.content;

        // Generate and save transcript using Gemini (more reliable than caption scraping)
        let transcriptPath: string | null = null;
        if (plugin.settings.saveTranscripts !== 'none') {
            try {
                logger.debug('Summary', 'Generating YouTube transcript with Gemini for:', url);
                const transcriptResult = await transcribeYouTubeWithGemini(
                    url,
                    geminiKey,
                    plugin.settings.youtubeGeminiModel,
                    plugin.settings.summarizeTimeoutSeconds * 1000
                );
                if (transcriptResult.success && transcriptResult.transcript) {
                    transcriptPath = await saveTranscriptToFile(
                        plugin,
                        transcriptResult.transcript,
                        videoInfo?.title || 'YouTube Video',
                        'youtube',
                        {
                            sourceUrl: url,
                            channelName: videoInfo?.channelName
                        }
                    );
                    if (transcriptPath) {
                        logger.debug('Summary', 'YouTube transcript saved to:', transcriptPath);
                    } else {
                        logger.warn('Summary', 'saveTranscriptToFile returned null - check folder permissions');
                    }
                } else {
                    logger.warn('Summary', 'YouTube transcript generation failed:', transcriptResult.error || 'Unknown reason');
                }
            } catch (transcriptError) {
                logger.warn('Summary', 'Could not generate YouTube transcript:', transcriptError);
                // Continue without transcript - Gemini's summary is still valid
            }
        }

        // Insert summary into editor with transcript link if available
        await insertYouTubeSummary(editor, summary, videoInfo, plugin, transcriptPath, true);

        // Update metadata with persona if structured metadata is enabled
        if (plugin.settings.enableStructuredMetadata && personaId && videoInfo) {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                        await updateNoteMetadataAfterSummary(
                    plugin,
                    view,
                            createSummaryHook(summary),
                    [],
                    'research',
                    'youtube',
                    url,
                    personaId
                );
            }
        }

        new Notice(`YouTube video summarized: ${videoInfo?.title?.substring(0, 40) || 'video'}...`);

    } catch (error) {
        logger.error('Summary', 'YouTube Gemini error:', error);
        new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Summarize YouTube transcript and insert into editor
 */
async function summarizeYouTubeAndInsert(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    videoInfo: YouTubeVideoInfo | undefined,
    personaPrompt: string,
    transcriptPath?: string | null,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const promptTemplate = buildSummaryPrompt(promptOptions);
    const prompt = insertContentIntoPrompt(promptTemplate, transcript);

    try {
        const response = await withBusyIndicator(plugin, () => summarizeTextWithLLM(plugin, prompt));

        if (response.success && response.content) {
            await insertYouTubeSummary(editor, response.content, videoInfo, plugin, transcriptPath, true);

            // Update metadata with persona if structured metadata is enabled
            if (plugin.settings.enableStructuredMetadata && personaId) {
                const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && videoInfo) {
                    await updateNoteMetadataAfterSummary(
                        plugin,
                        view,
                        createSummaryHook(response.content),
                        [],
                        'research',
                        'youtube',
                        getYouTubeUrl(videoInfo.videoId),
                        personaId
                    );
                }
            }
        } else {
            new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing: ${errorMessage}`);
    }
}

/**
 * Summarize YouTube transcript in chunks
 */
async function summarizeYouTubeInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    videoInfo: YouTubeVideoInfo | undefined,
    provider: string,
    personaPrompt: string,
    transcriptPath?: string | null,
    userContext?: string,
    personaId?: string
): Promise<void> {
    const { finalContent } = await withBusyIndicator(plugin, async () => {
        const result = await summarizeContentInChunks(plugin, transcript, provider, personaPrompt, userContext);
        return { finalContent: result };
    });

    await insertYouTubeSummary(editor, finalContent, videoInfo, plugin, transcriptPath, true);

    if (plugin.settings.enableStructuredMetadata && personaId) {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && videoInfo) {
            await updateNoteMetadataAfterSummary(
                plugin,
                view,
                createSummaryHook(finalContent),
                [],
                'research',
                'youtube',
                getYouTubeUrl(videoInfo.videoId),
                personaId
            );
        }
    }
}

/**
 * Insert YouTube summary into editor with metadata
 * Adds source to References section
 */
async function insertYouTubeSummary(
    editor: Editor,
    summary: string,
    videoInfo: YouTubeVideoInfo | undefined,
    plugin: AIOrganiserPlugin,
    transcriptPath?: string | null,
    showPreview = false
): Promise<SummaryResultAction | undefined> {
    let output = '';

    if (plugin.settings.includeSummaryMetadata && videoInfo) {
        output += `## Summary: ${videoInfo.title}\n\n`;
    }

    output += summary;

    // Add transcript link if available
    if (transcriptPath) {
        output += `\n\n> [!note] Full Transcript\n> [[${transcriptPath}|View full transcript]]\n`;
    }

    const doInsert = () => {
        const cursor = editor.getCursor();
        editor.replaceRange(output, cursor);

        if (videoInfo) {
            const sourceRef: SourceReference = {
                type: 'youtube',
                title: videoInfo.title,
                link: getYouTubeUrl(videoInfo.videoId),
                author: videoInfo.channelName,
                date: getTodayDate(),
                isInternal: false
            };
            addToReferencesSection(editor, sourceRef);
        }
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    };

    return showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview);
}

// Privacy notice gating is centralized via ensurePrivacyConsent()

/**
 * Show content size modal and wait for choice
 */
async function showContentSizeModal(
    plugin: AIOrganiserPlugin,
    contentLength: number,
    maxLength: number
): Promise<ContentSizeChoice> {
    return new Promise((resolve) => {
        const modal = new ContentSizeModal(plugin.app, plugin.t, contentLength, maxLength, (choice) => {
            resolve(choice);
        });
        modal.open();
    });
}

/**
 * Summarize content and insert into editor
 */
async function summarizeAndInsert(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    webContent: WebContent,
    personaPrompt: string,
    userContext?: string,
    personaId?: string
): Promise<void> {
    logger.debug('Summary', 'summarizeAndInsert called:', {
        contentLength: content?.length || 0,
        contentEmpty: !content || content.trim().length === 0,
        contentPreview: content?.substring(0, 300) || 'EMPTY',
        webContentUrl: webContent?.url,
        enableStructuredMetadata: plugin.settings.enableStructuredMetadata
    });

    // Use structured output if enabled, otherwise use traditional prompts
    if (plugin.settings.enableStructuredMetadata) {
        const promptOptions = {
            length: plugin.settings.summaryLength,
            language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
            personaPrompt: personaPrompt,
            userContext: userContext,
        };

        const promptTemplate = buildStructuredSummaryPrompt(promptOptions);
        const prompt = insertContentIntoStructuredPrompt(promptTemplate, content);

        logger.debug('Summary', 'Structured prompt:', {
            promptLength: prompt.length,
            hasContentPlaceholder: prompt.includes('{{CONTENT}}'),
            contentSectionStart: prompt.indexOf('<content>'),
            promptPreview: prompt.substring(prompt.indexOf('<content>'), prompt.indexOf('<content>') + 500)
        });

        try {
            const response = await withBusyIndicator(plugin, () => summarizeTextWithLLM(plugin, prompt));

            if (response.success && response.content) {
                // Parse structured response
                const structured = parseStructuredResponse(response.content);

                if (structured && !looksLikeRawJson(structured.body_content)) {
                    // Insert body content — only update metadata if user chose to insert
                    const action = await insertWebSummary(editor, structured.body_content, webContent, plugin, true);

                    if (action !== 'cursor') return;

                    // Update metadata - must save editor first to prevent race condition
                    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.file) {
                        // Force save editor changes to disk before updating frontmatter
                        // This prevents processFrontMatter from reading stale file content
                        await plugin.app.vault.modify(view.file, editor.getValue());

                        await updateNoteMetadataAfterSummary(
                            plugin,
                            view,
                            structured.summary_hook,
                            structured.suggested_tags || [],
                            structured.content_type || 'note',
                            'url',
                            webContent.url,
                            personaId
                        );
                    }
                } else {
                    // Structured parsing failed or returned raw JSON as body_content.
                    // Fall back: extract markdown from the response content directly.
                    logger.warn('Summary', 'Structured response parsing fell to fallback — inserting raw content as markdown.');
                    const markdownContent = stripJsonWrapperIfPresent(response.content);
                    await insertWebSummary(editor, markdownContent, webContent, plugin, true);
                }
            } else {
                new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Error summarizing content: ${errorMessage}`);
        }
    } else {
        // Traditional summarization without structured metadata
        const promptOptions: SummaryPromptOptions = {
            length: plugin.settings.summaryLength,
            language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
            personaPrompt: personaPrompt,
            userContext: userContext,
        };

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, content);

        try {
            const response = await withBusyIndicator(plugin, () => summarizeTextWithLLM(plugin, prompt));

            if (response.success && response.content) {
                await insertWebSummary(editor, response.content, webContent, plugin, true);
            } else {
                new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Error summarizing content: ${errorMessage}`);
        }
    }
}

/**
 * Summarize content in chunks using map-reduce approach
 */
async function summarizeInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    webContent: WebContent,
    provider: string,
    personaPrompt: string,
    userContext?: string
): Promise<void> {
    const { finalContent } = await withBusyIndicator(plugin, async () => {
        const result = await summarizeContentInChunks(plugin, content, provider, personaPrompt, userContext);
        return { finalContent: result };
    });

    await insertWebSummary(editor, finalContent, webContent, plugin, true);
}

/**
 * Summarize plain text and insert into editor
 */
async function summarizePlainTextAndInsert(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    personaPrompt: string,
    userContext?: string
): Promise<void> {
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const promptTemplate = buildSummaryPrompt(promptOptions);
    const prompt = insertContentIntoPrompt(promptTemplate, content);
    const title = plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary';

    try {
        const response = await withBusyIndicator(plugin, () => summarizeTextWithLLM(plugin, prompt));

        if (response.success && response.content) {
            await insertTextSummary(editor, response.content, plugin, title, true);
        } else {
            new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing content: ${errorMessage}`);
    }
}

/**
 * Summarize plain text in chunks using map-reduce approach
 */
async function summarizePlainTextInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    provider: string,
    personaPrompt: string,
    userContext?: string
): Promise<void> {
    const title = plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary';
    const combinedNotice = plugin.t.messages.summaryCombinedFromSections;

    const { finalContent } = await withBusyIndicator(plugin, async () => {
        const result = await summarizeContentInChunks(plugin, content, provider, personaPrompt, userContext);
        return { finalContent: result };
    });

    await insertTextSummary(editor, finalContent, plugin, title, true, combinedNotice);
}

/**
 * Detect whether body_content looks like raw JSON rather than parsed markdown.
 * This catches the case where parseStructuredResponse fell to the fallback
 * and set the entire JSON text (including code fences) as body_content.
 */
function looksLikeRawJson(text: string): boolean {
    const trimmed = text.trim();
    // Check for JSON object/code fence containing JSON keys
    return (trimmed.startsWith('```') && trimmed.includes('"body_content"'))
        || (trimmed.startsWith('{') && trimmed.includes('"body_content"') && trimmed.includes('"summary_hook"'));
}

/**
 * Best-effort extraction of readable content from an LLM response that
 * should have been structured JSON but couldn't be parsed.
 * Tries to extract body_content value; falls back to stripping JSON wrapper.
 */
function stripJsonWrapperIfPresent(text: string): string {
    // Try to extract body_content value using character-walking
    const bodyContent = extractBodyContentFromRawJson(text);
    if (bodyContent) return bodyContent;

    // Last resort: strip code fence and return as-is
    return text
        .replace(/^```(?:json)?\s*\r?\n/, '')
        .replace(/\r?\n```\s*$/, '')
        .trim();
}

/**
 * Walk the raw JSON text character-by-character to extract the body_content value.
 * Works even when JSON.parse fails (e.g., unescaped quotes, literal newlines).
 */
function extractBodyContentFromRawJson(text: string): string | null {
    const keyPattern = /"body_content"\s*:\s*"/;
    const keyMatch = keyPattern.exec(text);
    if (!keyMatch) return null;

    const valueStart = keyMatch.index + keyMatch[0].length;
    let result = '';
    let escape = false;

    for (let i = valueStart; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            switch (ch) {
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                case '"': result += '"'; break;
                case '\\': result += '\\'; break;
                case '/': result += '/'; break;
                default: result += ch; break;
            }
            escape = false;
            continue;
        }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') {
            // End of string value — return what we have
            return result.trim();
        }
        result += ch;
    }
    return result.trim() || null; // Unterminated string: return what we got
}

/**
 * Call LLM service to summarize text with optional RAG context
 */
async function summarizeTextWithLLM(
    plugin: AIOrganiserPlugin,
    prompt: string,
    useRAG: boolean = false
): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
        // Add RAG context if enabled
        let finalPrompt = prompt;
        let ragSources: string[] = [];

        if (useRAG && plugin.vectorStore && plugin.settings.enableSemanticSearch) {
            try {
                // Import RAGService
                const { RAGService } = await import('../services/ragService');
                const ragService = new RAGService(
                    plugin.vectorStore,
                    plugin.settings,
                    plugin.embeddingService
                );

                // Extract main query from prompt (first sentence)
                const queryMatch = prompt.match(/^([^.!?]+[.!?])/);
                const query = queryMatch ? queryMatch[1] : prompt.substring(0, 100);

                // Get related context
                const context = await ragService.retrieveContext(query, undefined, {
                    maxChunks: 3,
                    minSimilarity: 0.7
                });

                if (context.totalChunks > 0) {
                    // Build enhanced prompt with context
                    finalPrompt = ragService.buildRAGPrompt(
                        prompt,
                        context,
                        'You are a summarization assistant that incorporates relevant background knowledge from the user\'s vault.'
                    );
                    ragSources = context.sources;
                }
            } catch (ragError) {
                // Silently fail RAG, continue with regular summary
                console.debug('[AI Organiser] RAG summarization failed, continuing without context', ragError);
            }
        }

        const response = await summarizeText(pluginContext(plugin), finalPrompt);

        // Append sources if RAG was used
        if (useRAG && ragSources.length > 0 && response.success && response.content) {
            const { RAGService } = await import('../services/ragService');
            const ragService = new RAGService(
                plugin.vectorStore!,
                plugin.settings,
                plugin.embeddingService
            );
            const sourcesSection = ragService.formatSources(ragSources);
            response.content = response.content + '\n' + sourcesSection;
        }

        return response;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

/**
 * Call LLM service to summarize PDF
 */
async function summarizePdfWithLLM(
    plugin: AIOrganiserPlugin,
    pdfContent: PdfContent,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
        // Get PDF provider config (may be different from main provider)
        const pdfConfig = await getPdfProviderConfig(plugin);

        if (!pdfConfig) {
            return {
                success: false,
                error: plugin.t.settings.pdf?.noProviderConfigured ||
                    'PDF summarization requires Claude or Gemini. Configure a PDF provider in Settings.'
            };
        }

        // Create a cloud service with the PDF provider config
        const { CloudLLMService } = await import('../services/cloudService');

        // If main provider matches PDF provider, use existing service
        if (plugin.settings.serviceType === 'cloud' &&
            plugin.settings.cloudServiceType === pdfConfig.provider) {
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            const parts = [
                { type: 'document' as const, data: pdfContent.base64Data, mediaType: 'application/pdf' },
                { type: 'text' as const, text: prompt }
            ];
            const response = await cloudService.sendMultimodal(parts, { maxTokens: 4096 });
            return response;
        }

        // Create temporary service with PDF provider config
        const pdfCloudService = new CloudLLMService({
            type: pdfConfig.provider,
            endpoint: pdfConfig.provider === 'claude'
                ? 'https://api.anthropic.com/v1/messages'
                : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            apiKey: pdfConfig.apiKey,
            modelName: pdfConfig.model || (pdfConfig.provider === 'claude' ? 'claude-sonnet-4-6' : 'gemini-3-flash-preview')
        }, plugin.app);

        const parts = [
            { type: 'document' as const, data: pdfContent.base64Data, mediaType: 'application/pdf' },
            { type: 'text' as const, text: prompt }
        ];
        const response = await pdfCloudService.sendMultimodal(parts, { maxTokens: 4096 });
        return response;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

function isPdfPageLimitError(error?: string): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return normalized.includes('maximum of 100 pdf pages') ||
        normalized.includes('messages.0.content.0.pdf.source.base64.data');
}

async function summarizePdfByTextFallback(
    plugin: AIOrganiserPlugin,
    pdfPath: string,
    isVaultFile: boolean,
    options: PdfSummarizationOptions
): Promise<{ success: boolean; summary?: string; error?: string }> {
    const documentService = new DocumentExtractionService(plugin.app);

    let extractedText: string | undefined;

    if (isVaultFile) {
        let file = plugin.app.metadataCache.getFirstLinkpathDest(
            pdfPath,
            options.currentFilePath || ''
        );

        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(pdfPath);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }

        if (!file || !(file instanceof TFile)) {
            return {
                success: false,
                error: 'Could not find PDF file in vault for text fallback'
            };
        }

        const extracted = await documentService.extractText(file);
        if (!extracted.success || !extracted.text) {
            return {
                success: false,
                error: extracted.error || 'Failed to extract PDF text for fallback'
            };
        }
        extractedText = extracted.text;
    } else {
        const extracted = await documentService.extractFromUrl(pdfPath);
        if (!extracted.success || !extracted.text) {
            return {
                success: false,
                error: extracted.error || 'Failed to extract external PDF text for fallback'
            };
        }
        extractedText = extracted.text;
    }

    const pdfConfig = await getPdfProviderConfig(plugin);
    const provider = pdfConfig?.provider ||
        (plugin.settings.serviceType === 'cloud' ? plugin.settings.cloudServiceType : 'claude');

    const summary = await summarizeContentInChunks(
        plugin,
        extractedText,
        provider,
        options.personaPrompt,
        options.userContext
    );

    if (!summary || !summary.trim()) {
        return {
            success: false,
            error: 'Text fallback produced empty summary'
        };
    }

    return {
        success: true,
        summary
    };
}

// ============================================================================
// UNIFIED PDF SUMMARIZATION WORKFLOW
// ============================================================================

/**
 * Result from unified PDF summarization
 */
export interface PdfSummarizationResult {
    success: boolean;
    summary?: string;
    pdfContent?: PdfContent;
    error?: string;
}

/**
 * Options for PDF summarization
 */
export interface PdfSummarizationOptions {
    personaPrompt: string;
    userContext?: string;
    /** Current file for resolving vault links */
    currentFilePath?: string;
}

/**
 * Unified PDF summarization workflow that handles both vault and external PDFs.
 *
 * This function encapsulates the complete PDF summarization workflow:
 * 1. Resolves vault file paths using Obsidian's link resolution
 * 2. Reads the PDF (vault or external)
 * 3. Builds the summary prompt
 * 4. Calls the LLM service
 * 5. Returns the summary text
 *
 * Use this function for any PDF summarization to ensure consistent handling.
 *
 * @param plugin Plugin instance
 * @param pdfService PDF service for reading files
 * @param pdfPath Path to the PDF (vault path or external file path)
 * @param isVaultFile Whether the PDF is in the vault
 * @param options Summarization options
 * @returns Summarization result with summary text
 */
export async function summarizePdfWithFullWorkflow(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    pdfPath: string,
    isVaultFile: boolean,
    options: PdfSummarizationOptions
): Promise<PdfSummarizationResult> {
    // Step 1: Resolve and read the PDF
    let pdfResult: PdfServiceResult;

    if (isVaultFile) {
        // Use Obsidian's link resolution for vault files
        let file = plugin.app.metadataCache.getFirstLinkpathDest(
            pdfPath,
            options.currentFilePath || ''
        );

        // Fallback to direct path lookup
        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(pdfPath);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }

        if (!file || !(file instanceof TFile)) {
            return {
                success: false,
                error: 'Could not find PDF file in vault'
            };
        }

        pdfResult = await pdfService.readPdfAsBase64(file);
    } else {
        // External PDF
        pdfResult = await pdfService.readExternalPdfAsBase64(pdfPath);
    }

    if (!pdfResult.success || !pdfResult.content) {
        return {
            success: false,
            error: pdfResult.error || 'Failed to read PDF'
        };
    }

    // Step 2: Build the prompt
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: options.personaPrompt,
        userContext: options.userContext,
    };
    const prompt = buildSummaryPrompt(promptOptions);

    // Step 3: Call LLM to summarize
    const pdfContent = pdfResult.content; // Extract after narrowing for closure
    const response = await withBusyIndicator(plugin, () => summarizePdfWithLLM(plugin, pdfContent, prompt));

    if (!response.success || !response.content) {
        if (isPdfPageLimitError(response.error)) {
            new Notice('PDF exceeds multimodal page limit. Falling back to text extraction and chunked summarization.', 5000);

            const fallback = await withBusyIndicator(plugin, () => summarizePdfByTextFallback(
                plugin,
                pdfPath,
                isVaultFile,
                options
            ));

            if (fallback.success && fallback.summary) {
                return {
                    success: true,
                    summary: fallback.summary,
                    pdfContent: pdfResult.content
                };
            }

            return {
                success: false,
                error: fallback.error || response.error || 'Failed to summarize PDF'
            };
        }

        return {
            success: false,
            error: response.error || 'Failed to generate summary'
        };
    }

    return {
        success: true,
        summary: response.content,
        pdfContent: pdfResult.content
    };
}

/**
 * Insert web summary into editor
 * Adds source to References section
 */
async function insertWebSummary(
    editor: Editor,
    summary: string,
    webContent: WebContent,
    plugin: AIOrganiserPlugin,
    showPreview = false
): Promise<SummaryResultAction | undefined> {
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## ${webContent.title}\n\n`;
    }

    output += summary;

    // Add inline references for external links (kept in summary for context)
    const externalLinks = getExternalLinks(webContent.links || [], webContent.url);
    if (externalLinks.length > 0 && externalLinks.length <= 20) {
        output += '\n\n### Related Links\n\n';
        for (const link of externalLinks.slice(0, 15)) {
            const displayText = link.text.length > 60
                ? link.text.substring(0, 57) + '...'
                : link.text;
            output += `- [${displayText}](${link.href})\n`;
        }
    }

    const doInsert = () => {
        const cursor = editor.getCursor();
        editor.replaceRange(output, cursor);

        let sourceName = webContent.siteName || 'Source';
        try {
            sourceName = webContent.siteName || new URL(webContent.url).hostname;
        } catch {
            // Keep default
        }

        const sourceRef: SourceReference = {
            type: 'web',
            title: webContent.title || sourceName,
            link: webContent.url,
            author: webContent.byline || undefined,
            date: webContent.fetchedAt.toISOString().split('T')[0],
            isInternal: false
        };
        addToReferencesSection(editor, sourceRef);
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    };

    return showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview);
}

/**
 * Insert plain text summary into editor
 */
function insertTextSummary(
    editor: Editor,
    summary: string,
    plugin: AIOrganiserPlugin,
    title: string,
    showPreview: boolean = false,
    noticeMessage?: string
): Promise<SummaryResultAction> | undefined {
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## ${title}\n\n`;
    }

    output += summary;

    const doInsert = () => {
        editor.replaceRange(output, editor.getCursor());
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    };

    return showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview, noticeMessage);
}

/**
 * Filter links to only external (different domain) links
 */
function getExternalLinks(links: { text: string; href: string }[], sourceUrl: string): { text: string; href: string }[] {
    let sourceHost = '';
    try {
        sourceHost = new URL(sourceUrl).hostname;
    } catch {
        return [];
    }

    return links.filter(link => {
        try {
            const linkHost = new URL(link.href).hostname;
            return linkHost !== sourceHost;
        } catch {
            return false;
        }
    });
}

/**
 * Insert PDF summary into editor
 * Adds source to References section
 */
function insertPdfSummary(
    editor: Editor,
    summary: string,
    pdfContent: PdfContent,
    plugin: AIOrganiserPlugin,
    isInternal: boolean,
    showPreview: boolean = false
): Promise<SummaryResultAction> | undefined {
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${pdfContent.fileName}\n\n`;
    }

    output += summary;

    const doInsert = () => {
        editor.replaceRange(output, editor.getCursor());

        // Add source to References section
        const sourceRef: SourceReference = {
            type: 'pdf',
            title: pdfContent.fileName,
            link: pdfContent.filePath,
            date: getTodayDate(),
            isInternal: isInternal
        };
        addToReferencesSection(editor, sourceRef);
        ensureNoteStructureIfEnabled(editor, plugin.settings);
    };

    return showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview);
}

// Old offerAudioCompression removed — replaced by shared audioCleanupService.ts
