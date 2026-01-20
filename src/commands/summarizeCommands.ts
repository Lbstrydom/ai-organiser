/**
 * Summarize Commands
 * Commands for URL and PDF summarization
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { fetchArticle, openInBrowser, chunkContent, WebContent } from '../services/webContentService';
import { PdfService, serviceCanSummarizePdf, PdfContent } from '../services/pdfService';
import { buildSummaryPrompt, buildChunkCombinePrompt, insertContentIntoPrompt, insertSectionsIntoPrompt, SummaryPromptOptions } from '../services/prompts/summaryPrompts';
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
import { fetchYouTubeTranscript, isYouTubeUrl, getYouTubeUrl, YouTubeVideoInfo } from '../services/youtubeService';
import {
    transcribeAudio,
    getAvailableTranscriptionProvider,
    formatFileSize,
    MAX_FILE_SIZE_MB
} from '../services/audioTranscriptionService';

export function registerSummarizeCommands(plugin: AIOrganiserPlugin): void {
    const pdfService = new PdfService(plugin.app);

    // Reset privacy notice on plugin load
    resetPrivacyNotice();

    // Command: Summarize from URL
    plugin.addCommand({
        id: 'summarize-from-url',
        name: plugin.t.commands.summarizeFromUrl,
        icon: 'link',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            if (!plugin.settings.enableWebSummarization) {
                new Notice('Web summarization is disabled in settings');
                return;
            }

            // Show URL input modal with persona selection
            const modal = new UrlInputModal(
                plugin.app,
                plugin.t,
                plugin.settings.defaultSummaryPersona,
                async (result) => {
                    await handleUrlSummarization(plugin, pdfService, editor, result.url, result.personaId);
                }
            );
            modal.open();
        }
    });

    // Command: Summarize from PDF
    plugin.addCommand({
        id: 'summarize-from-pdf',
        name: plugin.t.commands.summarizeFromPdf,
        icon: 'file-text',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            if (!plugin.settings.enableWebSummarization) {
                new Notice('Web summarization is disabled in settings');
                return;
            }

            // Check if LLM supports PDF
            const serviceType = plugin.settings.serviceType === 'cloud'
                ? plugin.settings.cloudServiceType
                : 'local';

            if (!serviceCanSummarizePdf(serviceType)) {
                new Notice(plugin.t.messages.pdfNotSupported);
                return;
            }

            const defaultPersona = plugin.settings.defaultSummaryPersona;

            // Show PDF selection modal
            const pdfs = await pdfService.getPdfsInAttachments();
            if (pdfs.length === 0) {
                // Fall back to all PDFs in vault
                const allPdfs = pdfService.getAllPdfs();
                if (allPdfs.length === 0) {
                    new Notice(plugin.t.messages.noPdfsFound);
                    return;
                }
                const modal = new PdfSelectModal(plugin.app, plugin.t, allPdfs, defaultPersona, async (result) => {
                    await handlePdfSummarization(plugin, pdfService, editor, result.file, result.personaId);
                });
                modal.open();
                return;
            }

            const modal = new PdfSelectModal(plugin.app, plugin.t, pdfs, defaultPersona, async (result) => {
                await handlePdfSummarization(plugin, pdfService, editor, result.file, result.personaId);
            });
            modal.open();
        }
    });

    // Command: Summarize from YouTube
    plugin.addCommand({
        id: 'summarize-from-youtube',
        name: plugin.t.commands.summarizeFromYouTube || 'Summarize from YouTube',
        icon: 'youtube',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            if (!plugin.settings.enableWebSummarization) {
                new Notice('Web summarization is disabled in settings');
                return;
            }

            // Show YouTube input modal with persona selection
            const modal = new YouTubeInputModal(
                plugin.app,
                plugin.t,
                plugin.settings.defaultSummaryPersona,
                async (result) => {
                    await handleYouTubeSummarization(plugin, editor, result.url, result.personaId);
                }
            );
            modal.open();
        }
    });

    // Command: Summarize from Audio
    plugin.addCommand({
        id: 'summarize-from-audio',
        name: plugin.t.commands.summarizeFromAudio || 'Summarize from Audio',
        icon: 'mic',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            if (!plugin.settings.enableWebSummarization) {
                new Notice('Web summarization is disabled in settings');
                return;
            }

            // Check if transcription provider is available
            const cloudServiceType = plugin.settings.cloudServiceType;
            const apiKey = plugin.settings.cloudApiKey;
            const provider = getAvailableTranscriptionProvider(cloudServiceType, apiKey);

            if (!provider) {
                new Notice(
                    plugin.t.messages.transcriptionNotAvailable ||
                    'Audio transcription requires OpenAI or Groq API key. Please configure in settings.'
                );
                return;
            }

            // Show audio file selection modal
            const modal = new AudioSelectModal(
                plugin.app,
                plugin.t,
                async (result: AudioSelectResult) => {
                    await handleAudioSummarization(plugin, editor, result, provider);
                }
            );
            modal.open();
        }
    });
}

/**
 * Handle URL summarization with privacy notice, content size handling, and chunking
 */
async function handleUrlSummarization(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    url: string,
    personaId: string
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

        if (pdfFile && serviceCanSummarizePdf(serviceType)) {
            await handlePdfSummarization(plugin, pdfService, editor, pdfFile, personaId);
            return;
        } else if (!serviceCanSummarizePdf(serviceType)) {
            new Notice(plugin.t.messages.pdfNotSupported);
            return;
        } else {
            new Notice('Failed to download PDF');
            openInBrowser(url);
            return;
        }
    }

    new Notice(plugin.t.messages.fetchingUrl);

    const result = await fetchArticle(url);

    if (result.success && result.content) {
        // Check content size against limits
        const content = result.content.content; // Markdown content
        const maxChars = getMaxContentChars(serviceType);

        if (isContentTooLarge(content, serviceType)) {
            // Show content size modal for user choice
            const choice = await showContentSizeModal(plugin, content.length, maxChars);

            if (choice === 'cancel') {
                return;
            } else if (choice === 'truncate') {
                const truncatedContent = truncateContent(content, serviceType);
                await summarizeAndInsert(plugin, editor, truncatedContent, result.content, personaId);
                new Notice(plugin.t.messages.contentTruncated);
            } else if (choice === 'chunk') {
                await summarizeInChunks(plugin, editor, content, result.content, serviceType, personaId);
            }
        } else {
            await summarizeAndInsert(plugin, editor, content, result.content, personaId);
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
 * Handle PDF summarization
 */
async function handlePdfSummarization(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    file: TFile,
    personaId: string
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

    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: personaId,
    };

    const prompt = buildSummaryPrompt(promptOptions);

    try {
        // Send PDF to LLM for summarization
        // This will be handled by the adapter's summarizePdf method
        const response = await summarizePdfWithLLM(plugin, pdfResult.content, prompt);

        if (response.success && response.content) {
            insertPdfSummary(editor, response.content, pdfResult.content, plugin);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            new Notice(`PDF summarization failed: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing PDF: ${errorMessage}`);
    }
}

/**
 * Handle audio file transcription and summarization
 */
async function handleAudioSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    result: AudioSelectResult,
    provider: 'openai' | 'groq'
): Promise<void> {
    const { file, language, context } = result;
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

    // Check file size
    const fileSize = file.stat.size;
    if (fileSize > MAX_FILE_SIZE_MB * 1024 * 1024) {
        new Notice(
            (plugin.t.messages.audioFileTooLarge || 'Audio file too large') +
            ` (${formatFileSize(fileSize)}). ` +
            (plugin.t.messages.audioMaxSize || `Maximum size: ${MAX_FILE_SIZE_MB}MB`)
        );
        return;
    }

    new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');

    // Transcribe the audio with user-specified language and context
    const transcriptionResult = await transcribeAudio(plugin.app, file, {
        provider,
        apiKey: plugin.settings.cloudApiKey,
        language: language || plugin.settings.summaryLanguage || undefined,
        prompt: context || undefined
    });

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

    // Now summarize the transcript
    new Notice(plugin.t.messages.summarizingTranscript || 'Summarizing transcript...');

    // Check content size against limits
    const maxChars = getMaxContentChars(serviceType);

    if (isContentTooLarge(transcript, serviceType)) {
        // Show content size modal for user choice
        const choice = await showContentSizeModal(plugin, transcript.length, maxChars);

        if (choice === 'cancel') {
            return;
        } else if (choice === 'truncate') {
            const truncatedContent = truncateContent(transcript, serviceType);
            await summarizeAudioAndInsert(plugin, editor, truncatedContent, file, transcriptionResult.duration);
            new Notice(plugin.t.messages.contentTruncated);
        } else if (choice === 'chunk') {
            await summarizeAudioInChunks(plugin, editor, transcript, file, serviceType, transcriptionResult.duration);
        }
    } else {
        await summarizeAudioAndInsert(plugin, editor, transcript, file, transcriptionResult.duration);
    }
}

/**
 * Summarize audio transcript and insert into editor
 */
async function summarizeAudioAndInsert(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    file: TFile,
    duration?: number
): Promise<void> {
    if (plugin.settings.debugMode) {
        console.log('[AI Organiser] Transcript length:', transcript.length);
        console.log('[AI Organiser] Transcript preview:', transcript.substring(0, 500));
    }

    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: plugin.settings.defaultSummaryPersona,
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
            insertAudioSummary(editor, response.content, file, duration, plugin);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            new Notice(`Summarization failed: ${response.error || 'Unknown error'}`);
            // Still insert metadata with error message
            insertAudioSummary(editor, `[Summarization failed: ${response.error || 'No content returned'}]`, file, duration, plugin);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Error summarizing: ${errorMessage}`);
        // Still insert metadata with error message
        insertAudioSummary(editor, `[Error: ${errorMessage}]`, file, duration, plugin);
    }
}

/**
 * Summarize audio transcript in chunks
 */
async function summarizeAudioInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    transcript: string,
    file: TFile,
    provider: string,
    duration?: number
): Promise<void> {
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(transcript, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed',
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: plugin.settings.defaultSummaryPersona,
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
        personaId: plugin.settings.defaultSummaryPersona,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertAudioSummary(editor, response.content, file, duration, plugin);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            insertAudioSummary(editor, chunkSummaries.join('\n\n'), file, duration, plugin);
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        insertAudioSummary(editor, chunkSummaries.join('\n\n'), file, duration, plugin);
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
}

/**
 * Insert audio summary into editor with metadata
 */
function insertAudioSummary(
    editor: Editor,
    summary: string,
    file: TFile,
    duration: number | undefined,
    plugin: AIOrganiserPlugin
): void {
    const cursor = editor.getCursor();
    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${file.basename}\n\n`;
        output += `> Source: [[${file.path}]]\n`;
        if (duration) {
            const minutes = Math.floor(duration / 60);
            const seconds = Math.round(duration % 60);
            output += `> Duration: ${minutes}:${seconds.toString().padStart(2, '0')}\n`;
        }
        output += '\n';
    }

    output += summary;

    editor.replaceRange(output, cursor);
}

/**
 * Handle YouTube video summarization
 */
async function handleYouTubeSummarization(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    url: string,
    personaId: string
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

    // Validate YouTube URL
    if (!isYouTubeUrl(url)) {
        new Notice(plugin.t.messages.invalidYouTubeUrl || 'Invalid YouTube URL');
        return;
    }

    new Notice(plugin.t.messages.fetchingTranscript || 'Fetching transcript...');

    // Fetch transcript
    const result = await fetchYouTubeTranscript(url);

    if (!result.success || !result.transcript) {
        new Notice(result.error || 'Failed to fetch transcript');
        return;
    }

    const transcript = result.transcript;
    const videoInfo = result.videoInfo;

    // Check content size against limits
    const maxChars = getMaxContentChars(serviceType);

    if (isContentTooLarge(transcript, serviceType)) {
        // Show content size modal for user choice
        const choice = await showContentSizeModal(plugin, transcript.length, maxChars);

        if (choice === 'cancel') {
            return;
        } else if (choice === 'truncate') {
            const truncatedContent = truncateContent(transcript, serviceType);
            await summarizeYouTubeAndInsert(plugin, editor, truncatedContent, videoInfo, personaId);
            new Notice(plugin.t.messages.contentTruncated);
        } else if (choice === 'chunk') {
            await summarizeYouTubeInChunks(plugin, editor, transcript, videoInfo, serviceType, personaId);
        }
    } else {
        await summarizeYouTubeAndInsert(plugin, editor, transcript, videoInfo, personaId);
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
    personaId: string
): Promise<void> {
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: personaId,
    };

    const promptTemplate = buildSummaryPrompt(promptOptions);
    const prompt = insertContentIntoPrompt(promptTemplate, transcript);

    try {
        const response = await summarizeTextWithLLM(plugin, prompt);

        if (response.success && response.content) {
            insertYouTubeSummary(editor, response.content, videoInfo, plugin);
            new Notice(plugin.t.messages.summaryInserted);
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
    personaId: string
): Promise<void> {
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(transcript, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed',
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: personaId,
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
        personaId: personaId,
    };

    const combinePromptTemplate = buildChunkCombinePrompt(combinePromptOptions);
    const combinePrompt = insertSectionsIntoPrompt(combinePromptTemplate, chunkSummaries);

    try {
        const response = await summarizeTextWithLLM(plugin, combinePrompt);

        if (response.success && response.content) {
            insertYouTubeSummary(editor, response.content, videoInfo, plugin);
            new Notice(plugin.t.messages.summaryInserted);
        } else {
            insertYouTubeSummary(editor, chunkSummaries.join('\n\n'), videoInfo, plugin);
            new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
        }
    } catch (error) {
        insertYouTubeSummary(editor, chunkSummaries.join('\n\n'), videoInfo, plugin);
        new Notice(plugin.t.messages.summaryInserted + ' (combined from sections)');
    }
}

/**
 * Insert YouTube summary into editor with metadata
 */
function insertYouTubeSummary(
    editor: Editor,
    summary: string,
    videoInfo: YouTubeVideoInfo | undefined,
    plugin: AIOrganiserPlugin
): void {
    const cursor = editor.getCursor();
    let output = '';

    if (plugin.settings.includeSummaryMetadata && videoInfo) {
        output += `## Summary: ${videoInfo.title}\n\n`;
        output += `> Source: [${videoInfo.title}](${getYouTubeUrl(videoInfo.videoId)})\n`;
        output += `> Channel: ${videoInfo.channelName}\n\n`;
    }

    output += summary;

    editor.replaceRange(output, cursor);
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
    personaId: string
): Promise<void> {
    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: personaId,
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

/**
 * Summarize content in chunks using map-reduce approach
 */
async function summarizeInChunks(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    webContent: WebContent,
    provider: string,
    personaId: string
): Promise<void> {
    // Calculate chunk size (use 70% of max to leave room for prompt)
    const limits = getProviderLimits(provider);
    const maxChunkChars = Math.floor(limits.maxInputTokens * limits.charsPerToken * 0.5);

    const chunks = chunkContent(content, maxChunkChars);
    const chunkSummaries: string[] = [];

    const promptOptions: SummaryPromptOptions = {
        length: 'detailed', // Use detailed for chunk summaries
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaId: personaId,
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
        personaId: personaId,
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
 * Call LLM service to summarize text
 */
async function summarizeTextWithLLM(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
        // Use the formatRequest method to build the request
        const request = plugin.llmService.formatRequest(prompt);

        // Access the cloud service directly for summarization
        // This is a workaround until we add a proper summarize method to LLMService
        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;

            // Use the internal makeRequest method via adapter
            const response = await cloudService.summarizeText(prompt);
            return response;
        } else {
            // Local service - use the analyzeTags method as a workaround
            // The prompt already contains the content and instructions
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;

            const response = await localService.summarizeText(prompt);
            return response;
        }
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
        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;

            const response = await cloudService.summarizePdf(pdfContent.base64Data, prompt);
            return response;
        } else {
            return { success: false, error: 'PDF summarization requires a cloud LLM provider' };
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

/**
 * Insert web summary into editor
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

        // Primary source URL as clickable link
        let sourceName = webContent.siteName || 'Source';
        try {
            sourceName = webContent.siteName || new URL(webContent.url).hostname;
        } catch {
            // Keep default
        }
        output += `> **Source:** [${sourceName}](${webContent.url})\n`;
        if (webContent.byline) output += `> **Author:** ${webContent.byline}\n`;
        output += `> **Fetched:** ${webContent.fetchedAt.toISOString().split('T')[0]}\n`;

        // Count unique external references in content
        const externalLinks = getExternalLinks(webContent.links || [], webContent.url);
        if (externalLinks.length > 0) {
            output += `> **References:** ${externalLinks.length} external link${externalLinks.length > 1 ? 's' : ''}\n`;
        }
        output += '\n';
    }

    output += summary;

    // Add references section for external links (different domain from source)
    const externalLinks = getExternalLinks(webContent.links || [], webContent.url);

    // Only show references section if there are external links that might add value
    if (externalLinks.length > 0 && externalLinks.length <= 20) {
        output += '\n\n---\n\n### References\n\n';
        for (const link of externalLinks.slice(0, 15)) {
            // Clean up link text (truncate if too long)
            const displayText = link.text.length > 60
                ? link.text.substring(0, 57) + '...'
                : link.text;
            output += `- [${displayText}](${link.href})\n`;
        }
    }

    editor.replaceRange(output, cursor);
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
 */
function insertPdfSummary(
    editor: Editor,
    summary: string,
    pdfContent: PdfContent,
    plugin: AIOrganiserPlugin
): void {
    const cursor = editor.getCursor();

    let output = '';

    if (plugin.settings.includeSummaryMetadata) {
        output += `## Summary: ${pdfContent.fileName}\n\n`;
        output += `> Source: [[${pdfContent.filePath}]]\n\n`;
    }

    output += summary;

    editor.replaceRange(output, cursor);
}
