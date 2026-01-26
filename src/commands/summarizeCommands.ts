/**
 * Summarize Commands
 * Commands for URL and PDF summarization
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice, Platform, TFile, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { fetchArticle, openInBrowser, chunkContent, WebContent } from '../services/webContentService';
import { PdfService, PdfContent } from '../services/pdfService';
import { buildSummaryPrompt, buildChunkCombinePrompt, insertContentIntoPrompt, insertSectionsIntoPrompt, SummaryPromptOptions } from '../services/prompts/summaryPrompts';
import { buildStructuredSummaryPrompt, insertContentIntoStructuredPrompt } from '../services/prompts/structuredPrompts';
import { parseStructuredResponse } from '../utils/responseParser';
import { updateAIOMetadata, createSummaryHook } from '../utils/frontmatterUtils';
import { SourceType, DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS } from '../core/constants';
import { isContentTooLarge, getMaxContentChars, truncateContent, getProviderLimits } from '../services/tokenLimits';
import { shouldShowPrivacyNotice, markPrivacyNoticeShown, isCloudProvider, resetPrivacyNotice } from '../services/privacyNotice';
import { isPdfUrl, extractFilenameFromUrl } from '../utils/urlValidator';
import { UrlInputModal } from '../ui/modals/UrlInputModal';
import { PdfSelectModal } from '../ui/modals/PdfSelectModal';
import { YouTubeInputModal } from '../ui/modals/YouTubeInputModal';
import { AudioSelectModal, AudioSelectResult } from '../ui/modals/AudioSelectModal';
import { ContentSizeModal, ContentSizeChoice } from '../ui/modals/ContentSizeModal';
import { PrivacyNoticeModal } from '../ui/modals/PrivacyNoticeModal';
import { getLanguageNameForPrompt } from '../services/languages';
import {
    isYouTubeUrl,
    getYouTubeUrl,
    YouTubeVideoInfo,
    summarizeYouTubeWithGemini,
    transcribeYouTubeWithGemini
} from '../services/youtubeService';
import {
    transcribeAudio,
    transcribeAudioFromData,
    transcribeExternalAudio,
    transcribeChunkedAudioWithCleanup,
    ChunkedTranscriptionProgress
} from '../services/audioTranscriptionService';
import {
    compressAudio,
    CompressionProgress,
    needsChunking,
    compressAndChunkAudio,
    ChunkProgress
} from '../services/audioCompressionService';
import {
    addToReferencesSection,
    SourceReference,
    getTodayDate,
    formatDuration,
    ensureNoteStructureIfEnabled
} from '../utils/noteStructure';
import { SummarizeSourceModal, SummarizeSourceOption } from '../ui/modals/SummarizeSourceModal';
import { MultiSourceModal, MultiSourceModalResult } from '../ui/modals/MultiSourceModal';
import { isYouTubeUrl as isYouTubeUrlText } from '../utils/contentDetection';
import { removeProcessedSources } from '../utils/sourceDetection';
import { DocumentExtractionService } from '../services/documentExtractionService';

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

    // Build full path: pluginFolder/transcriptFolder
    const pluginFolder = plugin.settings.pluginFolder || 'AI-Organiser';
    const transcriptSubfolder = plugin.settings.transcriptFolder || 'Transcripts';
    const folder = `${pluginFolder}/${transcriptSubfolder}`;

    // Ensure plugin folder exists first, then transcript subfolder
    const pluginFolderPath = normalizePath(pluginFolder);
    if (!plugin.app.vault.getAbstractFileByPath(pluginFolderPath)) {
        await plugin.app.vault.createFolder(pluginFolderPath);
    }

    // Ensure transcript folder exists
    const folderPath = normalizePath(folder);
    const folderExists = plugin.app.vault.getAbstractFileByPath(folderPath);
    if (!folderExists) {
        await plugin.app.vault.createFolder(folderPath);
    }

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
        console.error('[AI Organiser] Failed to save transcript:', error);
        return null;
    }
}

/**
 * Get the Gemini API key for YouTube processing
 * Priority: 1) dedicated YouTube key, 2) main Gemini key if provider is Gemini, 3) provider settings
 */
function getYouTubeGeminiApiKey(plugin: AIOrganiserPlugin): string | null {
    // First, check for dedicated YouTube Gemini key
    if (plugin.settings.youtubeGeminiApiKey) {
        return plugin.settings.youtubeGeminiApiKey;
    }

    // If main provider is Gemini, use that key
    if (plugin.settings.cloudServiceType === 'gemini' && plugin.settings.cloudApiKey) {
        return plugin.settings.cloudApiKey;
    }

    // Check provider settings for Gemini
    if (plugin.settings.providerSettings?.gemini?.apiKey) {
        return plugin.settings.providerSettings.gemini.apiKey;
    }

    return null;
}

/**
 * Get the API key for audio transcription (Whisper)
 * Priority: 1) dedicated transcription key, 2) main key if provider matches, 3) provider settings
 */
function getAudioTranscriptionApiKey(plugin: AIOrganiserPlugin): { key: string; provider: 'openai' | 'groq' } | null {
    const selectedProvider = plugin.settings.audioTranscriptionProvider || 'openai';

    // First, check for dedicated transcription key
    if (plugin.settings.audioTranscriptionApiKey) {
        return { key: plugin.settings.audioTranscriptionApiKey, provider: selectedProvider };
    }

    // Check if main provider matches and has a key
    if (plugin.settings.cloudServiceType === selectedProvider && plugin.settings.cloudApiKey) {
        return { key: plugin.settings.cloudApiKey, provider: selectedProvider };
    }

    // Check provider settings for the selected provider
    const providerKey = plugin.settings.providerSettings?.[selectedProvider]?.apiKey;
    if (providerKey) {
        return { key: providerKey, provider: selectedProvider };
    }

    // Fallback: try the other provider if available
    const otherProvider = selectedProvider === 'openai' ? 'groq' : 'openai';

    if (plugin.settings.cloudServiceType === otherProvider && plugin.settings.cloudApiKey) {
        return { key: plugin.settings.cloudApiKey, provider: otherProvider as 'openai' | 'groq' };
    }

    const otherProviderKey = plugin.settings.providerSettings?.[otherProvider]?.apiKey;
    if (otherProviderKey) {
        return { key: otherProviderKey, provider: otherProvider as 'openai' | 'groq' };
    }

    return null;
}

/**
 * Get the PDF provider configuration
 * Returns the provider and API key to use for PDF processing
 * Priority: 1) main provider if PDF-capable, 2) dedicated PDF provider, 3) auto-detect from available keys
 */
function getPdfProviderConfig(plugin: AIOrganiserPlugin): { provider: 'claude' | 'gemini'; apiKey: string; model: string } | null {
    const mainProvider = plugin.settings.cloudServiceType;
    const mainApiKey = plugin.settings.cloudApiKey;

    // If main provider supports PDFs and has a key, use it
    if ((mainProvider === 'claude' || mainProvider === 'gemini') && mainApiKey) {
        return {
            provider: mainProvider,
            apiKey: mainApiKey,
            model: plugin.settings.cloudModel || ''
        };
    }

    // Check if dedicated PDF provider is configured
    const pdfProvider = plugin.settings.pdfProvider;
    const pdfApiKey = plugin.settings.pdfApiKey;

    // If specific PDF provider is selected (not auto)
    if (pdfProvider !== 'auto') {
        // First try dedicated PDF API key
        if (pdfApiKey) {
            return {
                provider: pdfProvider,
                apiKey: pdfApiKey,
                model: plugin.settings.pdfModel || ''
            };
        }
        // Then try provider settings for that provider
        const providerKey = plugin.settings.providerSettings?.[pdfProvider]?.apiKey;
        if (providerKey) {
            return {
                provider: pdfProvider,
                apiKey: providerKey,
                model: plugin.settings.pdfModel || plugin.settings.providerSettings?.[pdfProvider]?.model || ''
            };
        }
        // If provider matches main provider, use main key
        if (mainProvider === pdfProvider && mainApiKey) {
            return {
                provider: pdfProvider,
                apiKey: mainApiKey,
                model: plugin.settings.pdfModel || plugin.settings.cloudModel || ''
            };
        }
    }

    // Auto mode: try to find any available PDF-capable provider
    // Check Claude provider settings
    if (plugin.settings.providerSettings?.claude?.apiKey) {
        return {
            provider: 'claude',
            apiKey: plugin.settings.providerSettings.claude.apiKey,
            model: plugin.settings.providerSettings.claude.model || ''
        };
    }
    // Check Gemini provider settings
    if (plugin.settings.providerSettings?.gemini?.apiKey) {
        return {
            provider: 'gemini',
            apiKey: plugin.settings.providerSettings.gemini.apiKey,
            model: plugin.settings.providerSettings.gemini.model || ''
        };
    }

    return null;
}

/**
 * Check if PDF summarization is available (either main provider or dedicated PDF provider)
 */
function canSummarizePdf(plugin: AIOrganiserPlugin): boolean {
    return getPdfProviderConfig(plugin) !== null;
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
    plugin.addCommand({
        id: 'smart-summarize',
        name: plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summarize',
        icon: 'file-text',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            await executeSmartSummarize(plugin, pdfService, editor, ctx);
        }
    });
}

async function executeSmartSummarize(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo
): Promise<void> {
    if (!plugin.settings.enableWebSummarization) {
        new Notice(plugin.t.messages.webSummarizationDisabled);
        return;
    }

    const view = ctx instanceof MarkdownView ? ctx : null;
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    // Get current note content for source detection
    const noteContent = editor.getValue();

    // Open multi-source modal with auto-detected sources
    openMultiSourceModal(plugin, pdfService, editor, view, noteContent);
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
                console.error('Error in handleMultiSourceResult:', e);
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
    // Debug: Log what we received
    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] handleMultiSourceResult called with:', {
            summarizeNote: result.summarizeNote,
            urls: result.sources.urls.length,
            youtube: result.sources.youtube.length,
            pdfs: result.sources.pdfs,
            documents: result.sources.documents.length,
            audio: result.sources.audio.length,
            personaId: result.personaId
        });
    }

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
        result.sources.audio.length;

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
                console.error('Error in handleUrlSummarization:', e);
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
                console.error('Error in handleYouTubeSummarization:', e);
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
                        console.error('Error in handlePdfSummarization:', e);
                        new Notice(plugin.t.messages.errorProcessingPdf.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
                    }
                } else {
                    new Notice(plugin.t.messages.couldNotFindPdfFile.replace('{path}', pdf.path));
                }
            } else {
                try {
                    await handleExternalPdfSummarization(plugin, pdfService, editor, pdf.path, personaPrompt, result.focusContext, personaId);
                } catch (e) {
                    console.error('Error in handleExternalPdfSummarization:', e);
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
                console.error('Error in handleDocumentSummarization:', e);
                new Notice(plugin.t.messages.errorProcessingDocument.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
            }
            return;
        }
        if (result.sources.audio.length === 1) {
            // Audio requires the AudioSelectModal for transcription options
            void openAudioSummarizeModal(plugin, editor);
            return;
        }
    }

    // Multiple sources - process sequentially
    new Notice(plugin.t.messages.processingXSources.replace('{count}', String(totalSources)));

    const summaries: string[] = [];
    const sourceLabels: string[] = [];

    // Track source data for References and status checklist
    interface ProcessedSource {
        type: 'web' | 'youtube' | 'note' | 'pdf' | 'document' | 'audio';
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
            console.error('Failed to summarize note:', e);
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
            console.error(`Failed to summarize URL ${url}:`, e);
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
    const youtubeGeminiKey = getYouTubeGeminiApiKey(plugin);
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
            console.error(`Failed to summarize YouTube ${url}:`, e);
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

    // Process PDFs
    for (const pdf of result.sources.pdfs) {
        showProgress();
        const pdfTitle = pdf.path.split('/').pop() || pdf.path;

        try {
            let file: TFile | null = null;

            if (pdf.isVaultFile) {
                // Use Obsidian's link resolution
                const currentFile = view.file;
                file = plugin.app.metadataCache.getFirstLinkpathDest(pdf.path, currentFile?.path || '');

                // Fallback to direct path lookup
                if (!file) {
                    const directFile = plugin.app.vault.getAbstractFileByPath(pdf.path);
                    if (directFile instanceof TFile) {
                        file = directFile;
                    }
                }
            }

            if (file) {
                new Notice(plugin.t.messages.readingPdf.replace('{title}', pdfTitle), 3000);
                const pdfResult = await pdfService.readPdfAsBase64(file);

                if (pdfResult.success && pdfResult.content) {
                    // Build prompt for PDF summarization
                    const promptOptions: SummaryPromptOptions = {
                        length: plugin.settings.summaryLength,
                        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
                        personaPrompt: personaPrompt,
                        userContext: result.focusContext,
                    };
                    const prompt = buildSummaryPrompt(promptOptions);

                    // Use PDF-specific summarization
                    const summaryResult = await summarizePdfWithLLM(plugin, pdfResult.content, prompt);
                    if (summaryResult.success && summaryResult.content) {
                        summaries.push(summaryResult.content);
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
                            error: summaryResult.error || 'Failed to generate summary'
                        });
                    }
                } else {
                    allSources.push({
                        type: 'pdf',
                        url: pdf.path,
                        title: pdfTitle,
                        date: today,
                        success: false,
                        error: pdfResult.error || 'Failed to read PDF'
                    });
                }
            } else {
                allSources.push({
                    type: 'pdf',
                    url: pdf.path,
                    title: pdfTitle,
                    date: today,
                    success: false,
                    error: 'Could not find PDF file in vault'
                });
            }
        } catch (e) {
            console.error('Error processing PDF:', e);
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
            console.error('Error processing document:', e);
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
    const audioTranscriptionConfig = getAudioTranscriptionApiKey(plugin);
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

            // Find the audio file in the vault
            const audioFile = plugin.app.vault.getAbstractFileByPath(audio.path);
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

            new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...', 3000);

            // Transcribe the audio
            const transcriptionResult = await transcribeAudio(plugin.app, audioFile, {
                provider: audioTranscriptionConfig.provider,
                apiKey: audioTranscriptionConfig.key,
                language: plugin.settings.summaryLanguage || undefined
            });

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
            console.error('Error processing audio:', e);
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

    // If no summaries but we have sources, show the status checklist
    if (summaries.length === 0) {
        if (allSources.length > 1) {
            // Build and show the status checklist even for complete failure
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

            // Remove processed URLs first
            const urlsToRemove = allSources
                .filter((s: ProcessedSource) => s.url && s.type !== 'note')
                .map((s: ProcessedSource) => s.url as string);

            let fullContent = editor.getValue();
            if (urlsToRemove.length > 0) {
                fullContent = removeProcessedSources(fullContent, urlsToRemove);
            }

            // Insert the failure report
            const frontmatterMatch = fullContent.match(/^---\n[\s\S]*?\n---\n?/);
            const frontmatterEnd = frontmatterMatch ? frontmatterMatch[0].length : 0;
            const frontmatter = fullContent.substring(0, frontmatterEnd);
            editor.setValue(frontmatter + failureOutput.trimStart());

            new Notice(plugin.t.messages.noContentCouldBeSummarized, 5000);
        } else {
            // Single source failure
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
        // Synthesize multiple summaries
        const synthesisPrompt = buildSynthesisPrompt(summaries, sourceLabels, result.focusContext, personaPrompt);
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
            console.error('Failed to synthesize summaries:', e);
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

    // Remove successfully processed source URLs FIRST (before inserting summary)
    // Failed sources remain so user can try again or handle manually
    const urlsToRemove = allSources
        .filter((s: ProcessedSource) => s.url && s.type !== 'note' && s.success)
        .map((s: ProcessedSource) => s.url as string);

    let fullContent = editor.getValue();
    if (urlsToRemove.length > 0) {
        const cleanedContent = removeProcessedSources(fullContent, urlsToRemove);
        if (cleanedContent !== fullContent) {
            fullContent = cleanedContent;
            editor.setValue(fullContent);
        }
    }

    // Insert summary - replace content body (after frontmatter)
    // Find where the content body starts (after frontmatter if present)
    const frontmatterMatch = fullContent.match(/^---\n[\s\S]*?\n---\n?/);
    const frontmatterEnd = frontmatterMatch ? frontmatterMatch[0].length : 0;

    // Build new content: frontmatter + summary (replacing body)
    const frontmatter = fullContent.substring(0, frontmatterEnd);
    const newContent = frontmatter + combinedOutput.trimStart();

    editor.setValue(newContent);

    // Add successful sources to References section
    for (const source of allSources) {
        if (source.url && source.success) {
            const sourceRef: SourceReference = {
                type: source.type === 'web' ? 'web' : source.type === 'youtube' ? 'youtube' : 'note',
                title: source.title,
                link: source.url,
                date: source.date,
                isInternal: false
            };
            addToReferencesSection(editor, sourceRef);
        }
    }

    // Ensure note structure (References and Pending Integration sections)
    ensureNoteStructureIfEnabled(editor, plugin.settings);

    new Notice(`Summarized ${summaries.length} source(s)`);
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
        editor.setCursor(cursor);
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

        // Use the same approach as summarizeTextWithLLM
        let response: { success: boolean; content?: string; error?: string };

        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            response = await cloudService.summarizeText(finalPrompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            response = await localService.summarizeText(finalPrompt);
        }

        return response.success ? response.content || null : null;
    } catch (e) {
        console.error('Failed to summarize content:', e);
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
        if (isYouTubeUrlText(target.url)) {
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
        if (plugin.settings.debugMode) {
            console.log('[AI Organiser] Current file:', currentFile.path);
            console.log('[AI Organiser] Found PDF links in note:', pdfLinks);
        }
        for (const linkPath of pdfLinks) {
            const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, currentFile.path);
            if (plugin.settings.debugMode) {
                console.log('[AI Organiser] Resolving link:', linkPath, '-> resolved:', resolved?.path || 'null');
            }
            if (resolved instanceof TFile && resolved.extension === 'pdf') {
                embeddedPdfs.push(resolved);
            }
        }
        if (plugin.settings.debugMode) {
            console.log('[AI Organiser] Embedded PDFs found:', embeddedPdfs.map(f => f.path));
        }
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
    const transcriptionConfig = getAudioTranscriptionApiKey(plugin);

    if (!transcriptionConfig) {
        new Notice(
            plugin.t.settings.audioTranscription?.noKeyWarning ||
            'Audio transcription requires OpenAI or Groq API key. Configure in Settings > Audio Transcription.'
        );
        return;
    }

    const modal = new AudioSelectModal(
        plugin.app,
        plugin.t,
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

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    // Check if URL is a direct PDF link
    if (isPdfUrl(url)) {
        new Notice(plugin.t.messages.savingPdfFromUrl);

        // Try to download and save PDF
        const fileName = extractFilenameFromUrl(url) || `downloaded-${Date.now()}.pdf`;
        const pdfFile = await pdfService.downloadPdfToVault(url, fileName);

        if (pdfFile && canSummarizePdf(plugin)) {
            await handlePdfSummarization(plugin, pdfService, editor, pdfFile, personaPrompt);
            return;
        } else if (!canSummarizePdf(plugin)) {
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

    // Debug logging for URL fetch
    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] URL fetch result:', {
            success: result.success,
            error: result.error,
            hasContent: !!result.content,
            contentLength: result.content?.content?.length || 0,
            textContentLength: result.content?.textContent?.length || 0,
            title: result.content?.title
        });
    }

    if (result.success && result.content) {
        // Show progress - summarization can take a while for large content
        const contentSize = result.content.textContent?.length || 0;
        const sizeDesc = contentSize > 15000 ? 'large article' : contentSize > 5000 ? 'article' : 'content';
        new Notice(`Summarizing ${sizeDesc} (${Math.round(contentSize / 1000)}k chars)... This may take a moment.`, 15000);

        // Check content size against limits
        const content = result.content.content; // Markdown content
        const maxChars = getMaxContentChars(serviceType);

        // Debug logging for content being summarized
        if (plugin.settings.debugMode) {
            console.log('[AI Organiser] Content to summarize:', {
                length: content.length,
                preview: content.substring(0, 500)
            });
        }

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

    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
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

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    new Notice(plugin.t.messages.readingPdf);

    const pdfResult = await pdfService.readPdfAsBase64(file);

    if (!pdfResult.success || !pdfResult.content) {
        new Notice(pdfResult.error || 'Failed to read PDF');
        return;
    }

    await summarizePdfContent(plugin, editor, pdfResult.content, personaPrompt, userContext, true, personaId);
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

    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    new Notice(plugin.t.messages.readingPdf);

    const pdfResult = await pdfService.readExternalPdfAsBase64(filePath);
    if (!pdfResult.success || !pdfResult.content) {
        new Notice(pdfResult.error || 'Failed to read PDF');
        return;
    }

    await summarizePdfContent(plugin, editor, pdfResult.content, personaPrompt, userContext, false, personaId);
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
        return text.substring(0, maxChars) + '\n\n[Truncated...]';
    }

    const confirmMessage = `Document "${title}" is ${text.length} chars (limit ${maxChars}). Use full content?`;
    const useFull = await plugin.showConfirmationDialog(confirmMessage);
    return useFull ? text : text.substring(0, maxChars) + '\n\n[Truncated...]';
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

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
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

        // Check if file needs chunking (long audio > 20 minutes)
        // This supports files up to 6+ hours by splitting into 5-minute chunks
        const chunkingCheck = await needsChunking(plugin.app, file);

        if (chunkingCheck.needsChunking) {
            // CHUNKED PATH: For long audio files (20+ minutes)
            const durationMinutes = chunkingCheck.estimatedDuration
                ? Math.round(chunkingCheck.estimatedDuration / 60)
                : 'unknown';

            new Notice(
                `Processing ${durationMinutes} minute audio file. This may take a while...`
            );

            if (plugin.settings.debugMode) {
                console.log('[AI Organiser] Using chunked transcription:', chunkingCheck.reason);
            }

            // Step 1: Compress and split into chunks
            const chunkResult = await compressAndChunkAudio(
                plugin.app,
                file,
                (progress: ChunkProgress) => {
                    if (plugin.settings.debugMode) {
                        console.log('[AI Organiser] Chunk progress:', progress);
                    }
                    // Show progress notices for key stages
                    if (progress.stage === 'preparing') {
                        new Notice(progress.message);
                    } else if (progress.stage === 'compressing' && progress.progress % 25 === 0) {
                        new Notice(`Compressing: ${progress.progress}%`);
                    } else if (progress.stage === 'done') {
                        new Notice(progress.message);
                    } else if (progress.stage === 'error') {
                        new Notice(progress.message);
                    }
                }
            );

            if (!chunkResult.success || !chunkResult.chunks || !chunkResult.outputDir) {
                new Notice(
                    (plugin.t.messages.compressionFailed || 'Audio processing failed') +
                    `: ${chunkResult.error || 'Unknown error'}`
                );
                return;
            }

            new Notice(`Transcribing ${chunkResult.chunks.length} chunks...`);

            // Step 2: Transcribe all chunks with context chaining
            transcriptionResult = await transcribeChunkedAudioWithCleanup(
                chunkResult.chunks,
                chunkResult.outputDir,
                {
                    provider,
                    apiKey,
                    language: language || plugin.settings.summaryLanguage || undefined,
                    prompt: context || undefined
                },
                (progress: ChunkedTranscriptionProgress) => {
                    if (plugin.settings.debugMode) {
                        console.log('[AI Organiser] Transcription progress:', progress);
                    }
                    // Show progress every few chunks or on completion
                    if (progress.currentChunk === 1 ||
                        progress.currentChunk === progress.totalChunks ||
                        progress.currentChunk % 3 === 0) {
                        new Notice(`Transcribing chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.globalPercent}%)`);
                    }
                }
            );

            // Set duration from chunk result
            if (chunkResult.totalDuration && transcriptionResult.success) {
                transcriptionResult.duration = chunkResult.totalDuration;
            }

        } else if (needsCompression) {
            // COMPRESSION PATH: For files > 25MB but < 20 minutes
            new Notice(plugin.t.messages.compressingAudio || 'Compressing audio file...');

            const compressionResult = await compressAudio(
                plugin.app,
                file,
                (progress: CompressionProgress) => {
                    if (plugin.settings.debugMode) {
                        console.log('[AI Organiser] Compression progress:', progress);
                    }
                    // Show progress notices for key stages
                    if (progress.stage === 'loading' || progress.stage === 'done' || progress.stage === 'error') {
                        new Notice(progress.message);
                    }
                }
            );

            if (!compressionResult.success || !compressionResult.data) {
                new Notice(
                    (plugin.t.messages.compressionFailed || 'Compression failed') +
                    `: ${compressionResult.error || 'Unknown error'}`
                );
                return;
            }

            new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');

            // Transcribe the compressed audio
            transcriptionResult = await transcribeAudioFromData(
                compressionResult.data,
                file.basename + '_compressed.mp3',
                {
                    provider,
                    apiKey,
                    language: language || plugin.settings.summaryLanguage || undefined,
                    prompt: context || undefined
                }
            );
        } else {
            // DIRECT PATH: For small files (< 25MB and < 20 minutes)
            new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');

            // Transcribe the audio directly
            transcriptionResult = await transcribeAudio(plugin.app, file, {
                provider,
                apiKey,
                language: language || plugin.settings.summaryLanguage || undefined,
                prompt: context || undefined
            });
        }
    } else {
        new Notice('No audio file selected');
        return;
    }

    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] Transcription result:', transcriptionResult);
    }

    if (!transcriptionResult.success || !transcriptionResult.transcript) {
        new Notice(
            (plugin.t.messages.transcriptionFailed || 'Transcription failed') +
            `: ${transcriptionResult.error || 'Unknown error'}`
        );
        return;
    }

    const transcript = transcriptionResult.transcript;

    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] Transcript received, length:', transcript.length);
    }

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

    if (transcriptPath && plugin.settings.debugMode) {
        console.log('[AI Organiser] Transcript saved to:', transcriptPath);
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
    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] Transcript length:', transcript.length);
        console.log('[AI Organiser] Transcript preview:', transcript.substring(0, 500));
    }

    // Get persona prompt if not provided
    const actualPersonaPrompt = personaPrompt || await plugin.configService.getSummaryPersonaPrompt(plugin.settings.defaultSummaryPersona);

    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: actualPersonaPrompt,
    };

    const promptTemplate = buildSummaryPrompt(promptOptions);
    const prompt = insertContentIntoPrompt(promptTemplate, transcript);

    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] Summary prompt length:', prompt.length);
    }

    try {
        const response = await summarizeTextWithLLM(plugin, prompt);

        if (plugin.settings.debugMode) {
            console.log('[AI Organiser] Summary response:', response);
        }

        if (response.success && response.content) {
            insertAudioSummary(editor, response.content, file, duration, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
            // Still insert metadata with error message
            insertAudioSummary(editor, `[Summarization failed: ${response.error || 'No content returned'}]`, file, duration, plugin, transcriptPath);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing: ${errorMessage}`);
        // Still insert metadata with error message
        insertAudioSummary(editor, `[Error: ${errorMessage}]`, file, duration, plugin, transcriptPath);
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
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(transcript, maxChunkChars);
    const chunkSummaries: string[] = [];

    // Get persona prompt from config
    const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(plugin.settings.defaultSummaryPersona);

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed',
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
    };

    // Map phase: summarize each chunk
    for (let i = 0; i < chunks.length; i++) {
        new Notice(
            plugin.t.messages.summarizingChunk
                .replace('{current}', String(i + 1))
                .replace('{total}', String(chunks.length))
        );

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, chunks[i]);

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                chunkSummaries.push(response.content);
            } else {
                chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
            }
        } catch (error) {
            chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
        }
    }

    // Reduce phase: combine summaries
    new Notice(plugin.t.messages.combiningChunks);

    const combinePromptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertAudioSummary(editor, response.content, file, duration, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            insertAudioSummary(editor, chunkSummaries.join('\n\n'), file, duration, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        insertAudioSummary(editor, chunkSummaries.join('\n\n'), file, duration, plugin, transcriptPath);
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
}

/**
 * Insert audio summary into editor with metadata
 * Adds source to References section
 */
function insertAudioSummary(
    editor: Editor,
    summary: string,
    file: AudioFileInfo,
    duration: number | undefined,
    plugin: AIOrganiserPlugin,
    transcriptPath?: string | null
): void {
    const cursor = editor.getCursor();
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${file.basename}\n\n`;
    }

    output += summary;

    // Add transcript link if available
    if (transcriptPath) {
        output += `\n\n> [!note] Full Transcript\n> [[${transcriptPath}|View full transcript]]\n`;
    }

    // Insert summary at cursor
    editor.replaceRange(output, cursor);

    // Add source to References section
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
    const geminiKey = getYouTubeGeminiApiKey(plugin);
    if (!geminiKey) {
        new Notice(plugin.t.settings.youtube?.noKeyWarning || 'Configure Gemini API key in Settings > YouTube to enable video processing');
        return;
    }

    // Show privacy notice for Gemini (cloud provider)
    if (shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, 'gemini');
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
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
                console.log('[AI Organiser] Generating YouTube transcript with Gemini for:', url);
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
                        console.log('[AI Organiser] YouTube transcript saved to:', transcriptPath);
                    } else {
                        console.warn('[AI Organiser] saveTranscriptToFile returned null - check folder permissions');
                    }
                } else {
                    console.warn('[AI Organiser] YouTube transcript generation failed:', transcriptResult.error || 'Unknown reason');
                }
            } catch (transcriptError) {
                console.warn('[AI Organiser] Could not generate YouTube transcript:', transcriptError);
                // Continue without transcript - Gemini's summary is still valid
            }
        }

        // Insert summary into editor with transcript link if available
        insertYouTubeSummary(editor, summary, videoInfo, plugin, transcriptPath);

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
        console.error('[AI Organiser] YouTube Gemini error:', error);
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
        const response = await summarizeTextWithLLM(plugin, prompt);

        if (response.success && response.content) {
            insertYouTubeSummary(editor, response.content, videoInfo, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted);

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
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(transcript, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed',
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    // Map phase: summarize each chunk
    for (let i = 0; i < chunks.length; i++) {
        new Notice(
            plugin.t.messages.summarizingChunk
                .replace('{current}', String(i + 1))
                .replace('{total}', String(chunks.length))
        );

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, chunks[i]);

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                chunkSummaries.push(response.content);
            } else {
                chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
            }
        } catch (error) {
            chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
        }
    }

    // Reduce phase: combine summaries
    new Notice(plugin.t.messages.combiningChunks);

    const combinePromptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertYouTubeSummary(editor, response.content, videoInfo, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted);

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
            insertYouTubeSummary(editor, chunkSummaries.join('\n\n'), videoInfo, plugin, transcriptPath);
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        insertYouTubeSummary(editor, chunkSummaries.join('\n\n'), videoInfo, plugin, transcriptPath);
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
}

/**
 * Insert YouTube summary into editor with metadata
 * Adds source to References section
 */
function insertYouTubeSummary(
    editor: Editor,
    summary: string,
    videoInfo: YouTubeVideoInfo | undefined,
    plugin: AIOrganiserPlugin,
    transcriptPath?: string | null
): void {
    const cursor = editor.getCursor();
    let output = '';

    if (plugin.settings.includeSummaryMetadata && videoInfo) {
        output += `## Summary: ${videoInfo.title}\n\n`;
    }

    output += summary;

    // Add transcript link if available
    if (transcriptPath) {
        output += `\n\n> [!note] Full Transcript\n> [[${transcriptPath}|View full transcript]]\n`;
    }

    // Insert summary at cursor
    editor.replaceRange(output, cursor);

    // Add source to References section
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
}

/**
 * Show privacy notice modal and wait for response
 */
async function showPrivacyNotice(plugin: AIOrganiserPlugin, provider: string): Promise<boolean> {
    return new Promise((resolve) => {
        const modal = new PrivacyNoticeModal(plugin.app, plugin.t, provider, (proceed) => {
            resolve(proceed);
        });
        modal.open();
    });
}

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
    // Debug logging for summarizeAndInsert
    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] summarizeAndInsert called:', {
            contentLength: content?.length || 0,
            contentEmpty: !content || content.trim().length === 0,
            contentPreview: content?.substring(0, 300) || 'EMPTY',
            webContentUrl: webContent?.url,
            enableStructuredMetadata: plugin.settings.enableStructuredMetadata
        });
    }

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

        // Debug logging for prompt
        if (plugin.settings.debugMode) {
            console.log('[AI Organiser] Structured prompt:', {
                promptLength: prompt.length,
                hasContentPlaceholder: prompt.includes('{{CONTENT}}'),
                contentSectionStart: prompt.indexOf('<content>'),
                promptPreview: prompt.substring(prompt.indexOf('<content>'), prompt.indexOf('<content>') + 500)
            });
        }

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                // Parse structured response
                const structured = parseStructuredResponse(response.content);

                if (structured) {
                    // Insert body content
                    insertWebSummary(editor, structured.body_content, webContent, plugin);
                    new Notice(plugin.t.messages.summaryInserted);

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
                    new Notice('Failed to parse structured response');
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
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                insertWebSummary(editor, response.content, webContent, plugin);
                new Notice(plugin.t.messages.summaryInserted);
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
    // Calculate chunk size (use 70% of max to leave room for prompt)
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(content, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed', // Use detailed for chunk summaries
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    // Map phase: summarize each chunk
    for (let i = 0; i < chunks.length; i++) {
        new Notice(
            plugin.t.messages.summarizingChunk
                .replace('{current}', String(i + 1))
                .replace('{total}', String(chunks.length))
        );

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, chunks[i]);

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                chunkSummaries.push(response.content);
            } else {
                chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
            }
        } catch (error) {
            chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
        }
    }

    // Reduce phase: combine summaries
    new Notice(plugin.t.messages.combiningChunks);

    const combinePromptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertWebSummary(editor, response.content, webContent, plugin);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            // Fall back to concatenated summaries
            insertWebSummary(editor, chunkSummaries.join('\n\n'), webContent, plugin);
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        // Fall back to concatenated summaries
        insertWebSummary(editor, chunkSummaries.join('\n\n'), webContent, plugin);
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
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

    try {
        const response = await summarizeTextWithLLM(plugin, prompt);

        if (response.success && response.content) {
            insertTextSummary(
                editor,
                response.content,
                plugin,
                plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary'
            );
            new Notice(plugin.t.messages.summaryInserted);
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
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(content, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed',
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    for (let i = 0; i < chunks.length; i++) {
        new Notice(
            plugin.t.messages.summarizingChunk
                .replace('{current}', String(i + 1))
                .replace('{total}', String(chunks.length))
        );

        const promptTemplate = buildSummaryPrompt(promptOptions);
        const prompt = insertContentIntoPrompt(promptTemplate, chunks[i]);

        try {
            const response = await summarizeTextWithLLM(plugin, prompt);

            if (response.success && response.content) {
                chunkSummaries.push(response.content);
            } else {
                chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
            }
        } catch (error) {
            chunkSummaries.push(`[Error summarizing section ${i + 1}]`);
        }
    }

    new Notice(plugin.t.messages.combiningChunks);

    const combinePromptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertTextSummary(
                editor,
                response.content,
                plugin,
                plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary'
            );
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            insertTextSummary(
                editor,
                chunkSummaries.join('\n\n'),
                plugin,
                plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary'
            );
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        insertTextSummary(
            editor,
            chunkSummaries.join('\n\n'),
            plugin,
            plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary'
        );
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
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

        // Use the formatRequest method to build the request
        const request = plugin.llmService.formatRequest(finalPrompt);

        // Access the cloud service directly for summarization
        // This is a workaround until we add a proper summarize method to LLMService
        let response: { success: boolean; content?: string; error?: string };
        
        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;

            // Use the internal makeRequest method via adapter
            response = await cloudService.summarizeText(finalPrompt);
        } else {
            // Local service - use the analyzeTags method as a workaround
            // The prompt already contains the content and instructions
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;

            response = await localService.summarizeText(finalPrompt);
        }

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
        const pdfConfig = getPdfProviderConfig(plugin);

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
            const response = await cloudService.summarizePdf(pdfContent.base64Data, prompt);
            return response;
        }

        // Create temporary service with PDF provider config
        const pdfCloudService = new CloudLLMService({
            type: pdfConfig.provider,
            endpoint: pdfConfig.provider === 'claude'
                ? 'https://api.anthropic.com/v1/messages'
                : 'https://generativelanguage.googleapis.com/v1beta/openai',
            apiKey: pdfConfig.apiKey,
            modelName: pdfConfig.model || (pdfConfig.provider === 'claude' ? 'claude-sonnet-4-5-20250929' : 'gemini-3-flash-preview')
        }, plugin.app);

        const response = await pdfCloudService.summarizePdf(pdfContent.base64Data, prompt);
        return response;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

/**
 * Summarize PDF content and insert into editor
 */
async function summarizePdfContent(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    pdfContent: PdfContent,
    personaPrompt: string,
    userContext: string | undefined,
    isInternal: boolean,
    personaId?: string
): Promise<void> {
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
        userContext: userContext,
    };

    const prompt = buildSummaryPrompt(promptOptions);

    try {
        const response = await summarizePdfWithLLM(plugin, pdfContent, prompt);

        if (response.success && response.content) {
            insertPdfSummary(editor, response.content, pdfContent, plugin, isInternal);
            new Notice(plugin.t.messages.summaryInserted);

            // Update metadata with persona if structured metadata is enabled
            if (plugin.settings.enableStructuredMetadata && personaId) {
                const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                if (view) {
                        await updateNoteMetadataAfterSummary(
                        plugin,
                        view,
                            createSummaryHook(response.content),
                        [],
                        'reference',
                        'pdf',
                        pdfContent.filePath,
                        personaId
                    );
                }
            }
        } else {
            new Notice(`PDF summarization failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing PDF: ${errorMessage}`);
    }
}

/**
 * Insert web summary into editor
 * Adds source to References section
 */
function insertWebSummary(
    editor: Editor,
    summary: string,
    webContent: WebContent,
    plugin: AIOrganiserPlugin
): void {
    const cursor = editor.getCursor();

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

    // Insert summary at cursor
    editor.replaceRange(output, cursor);

    // Add primary source to References section
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

    // Note: We don't add to Pending Integration because the URL has been processed
    // Pending Integration is for raw content that hasn't been summarized yet

    ensureNoteStructureIfEnabled(editor, plugin.settings);
}

/**
 * Insert plain text summary into editor
 */
function insertTextSummary(
    editor: Editor,
    summary: string,
    plugin: AIOrganiserPlugin,
    title: string
): void {
    const cursor = editor.getCursor();
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## ${title}\n\n`;
    }

    output += summary;
    editor.replaceRange(output, cursor);
    ensureNoteStructureIfEnabled(editor, plugin.settings);
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
    isInternal: boolean
): void {
    const cursor = editor.getCursor();

    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${pdfContent.fileName}\n\n`;
    }

    output += summary;

    // Insert summary at cursor
    editor.replaceRange(output, cursor);

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
}
