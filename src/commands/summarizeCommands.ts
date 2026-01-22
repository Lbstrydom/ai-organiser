/**
 * Summarize Commands
 * Commands for URL and PDF summarization
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice, Platform, TFile, normalizePath } from 'obsidian';
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
    transcribeAudioFromData,
    transcribeExternalAudio,
    getAvailableTranscriptionProvider
} from '../services/audioTranscriptionService';
import {
    compressAudio,
    CompressionProgress
} from '../services/audioCompressionService';
import {
    addToReferencesSection,
    SourceReference,
    getTodayDate,
    formatDuration,
    ensureNoteStructureIfEnabled
} from '../utils/noteStructure';
import { SummarizeSourceModal, SummarizeSourceOption } from '../ui/modals/SummarizeSourceModal';
import { isYouTubeUrl as isYouTubeUrlText } from '../utils/contentDetection';

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
        new Notice('Web summarization is disabled in settings');
        return;
    }

    const view = ctx instanceof MarkdownView ? ctx : null;
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(
        plugin.settings.defaultSummaryPersona
    );

    const selection = editor.getSelection().trim();
    if (selection) {
        const selectionTarget = detectTargetFromText(plugin, selection, view.file, false);
        if (selectionTarget.type !== 'none') {
            await handleSmartTarget(plugin, pdfService, editor, selectionTarget, personaPrompt);
            return;
        }

        if (selection.length > 50) {
            await handleTextSummarization(plugin, editor, selection, personaPrompt);
            return;
        }
    }

    const line = editor.getLine(editor.getCursor().line);
    if (isYouTubeUrlText(line)) {
        const url = extractUrl(line);
        if (url) {
            await handleYouTubeSummarization(plugin, editor, url, personaPrompt);
            return;
        }
    }

    const lineTarget = detectTargetFromText(plugin, line, view.file, false);
    if (lineTarget.type !== 'none') {
        await handleSmartTarget(plugin, pdfService, editor, lineTarget, personaPrompt);
        return;
    }

    const frontmatterTarget = detectTargetFromFrontmatter(plugin, view.file);
    if (frontmatterTarget.type !== 'none') {
        await handleSmartTarget(plugin, pdfService, editor, frontmatterTarget, personaPrompt);
        return;
    }

    openSummarizeSourceModal(plugin, pdfService, editor, view, personaPrompt);
}

async function handleSmartTarget(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    target: SmartSummarizeTarget,
    personaPrompt: string
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
            await handleYouTubeSummarization(plugin, editor, target.url, personaPrompt);
            return;
        }
        await handleUrlSummarization(plugin, pdfService, editor, target.url, personaPrompt);
        return;
    }

    if (target.type === 'internal-pdf') {
        if (!serviceCanSummarizePdf(serviceType)) {
            new Notice(plugin.t.messages.pdfNotSupported);
            return;
        }
        await handlePdfSummarization(plugin, pdfService, editor, target.file, personaPrompt);
        return;
    }

    if (target.type === 'external-pdf') {
        if (Platform.isMobile) {
            new Notice(plugin.t.messages.externalFilesDesktopOnly || 'External files are desktop-only');
            return;
        }
        if (!serviceCanSummarizePdf(serviceType)) {
            new Notice(plugin.t.messages.pdfNotSupported);
            return;
        }
        await handleExternalPdfSummarization(plugin, pdfService, editor, target.path, personaPrompt);
        return;
    }
}

function openSummarizeSourceModal(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    editor: Editor,
    view: MarkdownView,
    personaPrompt: string
): void {
    const modal = new SummarizeSourceModal(plugin.app, plugin, (source: SummarizeSourceOption) => {
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
    });
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
            await handleUrlSummarization(plugin, pdfService, editor, result.url, personaPrompt, result.context);
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
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    if (!serviceCanSummarizePdf(serviceType)) {
        new Notice(plugin.t.messages.pdfNotSupported);
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
                await handlePdfSummarization(plugin, pdfService, editor, result.file, personaPrompt, result.context);
            }
        },
        async (result) => {
            const personaPrompt = await plugin.configService.getSummaryPersonaPrompt(result.personaId);
            await handleExternalPdfSummarization(plugin, pdfService, editor, result.externalPath, personaPrompt, result.context);
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
            await handleYouTubeSummarization(plugin, editor, result.url, personaPrompt, result.context);
        }
    );
    modal.open();
}

async function openAudioSummarizeModal(
    plugin: AIOrganiserPlugin,
    editor: Editor
): Promise<void> {
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

    const modal = new AudioSelectModal(
        plugin.app,
        plugin.t,
        async (result: AudioSelectResult) => {
            await handleAudioSummarization(plugin, editor, result, provider);
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
    userContext?: string
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
            await handlePdfSummarization(plugin, pdfService, editor, pdfFile, personaPrompt);
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
                await summarizeAndInsert(plugin, editor, truncatedContent, result.content, personaPrompt, userContext);
                new Notice(plugin.t.messages.contentTruncated);
            } else if (choice === 'chunk') {
                await summarizeInChunks(plugin, editor, content, result.content, serviceType, personaPrompt, userContext);
            }
        } else {
            await summarizeAndInsert(plugin, editor, content, result.content, personaPrompt, userContext);
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
    userContext?: string
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

    await summarizePdfContent(plugin, editor, pdfResult.content, personaPrompt, userContext, true);
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

    new Notice(plugin.t.messages.readingPdf);

    const pdfResult = await pdfService.readExternalPdfAsBase64(filePath);
    if (!pdfResult.success || !pdfResult.content) {
        new Notice(pdfResult.error || 'Failed to read PDF');
        return;
    }

    await summarizePdfContent(plugin, editor, pdfResult.content, personaPrompt, userContext, false);
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
            apiKey: plugin.settings.cloudApiKey,
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

        if (needsCompression) {
            // Compress the audio first
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
                    apiKey: plugin.settings.cloudApiKey,
                    language: language || plugin.settings.summaryLanguage || undefined,
                    prompt: context || undefined
                }
            );
        } else {
            new Notice(plugin.t.messages.transcribingAudio || 'Transcribing audio...');

            // Transcribe the audio directly
            transcriptionResult = await transcribeAudio(plugin.app, file, {
                provider,
                apiKey: plugin.settings.cloudApiKey,
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
    userContext?: string
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

    // Save transcript to file if enabled
    const transcriptPath = await saveTranscriptToFile(
        plugin,
        transcript,
        videoInfo?.title || 'YouTube Video',
        'youtube',
        {
            sourceUrl: url,
            channelName: videoInfo?.channelName
        }
    );

    if (transcriptPath && plugin.settings.debugMode) {
        console.log('[AI Organiser] YouTube transcript saved to:', transcriptPath);
    }

    // Check content size against limits
    const maxChars = getMaxContentChars(serviceType);

    if (isContentTooLarge(transcript, serviceType)) {
        // Show content size modal for user choice
        const choice = await showContentSizeModal(plugin, transcript.length, maxChars);

        if (choice === 'cancel') {
            return;
        } else if (choice === 'truncate') {
            const truncatedContent = truncateContent(transcript, serviceType);
            await summarizeYouTubeAndInsert(plugin, editor, truncatedContent, videoInfo, personaPrompt, transcriptPath, userContext);
            new Notice(plugin.t.messages.contentTruncated);
        } else if (choice === 'chunk') {
            await summarizeYouTubeInChunks(plugin, editor, transcript, videoInfo, serviceType, personaPrompt, transcriptPath, userContext);
        }
    } else {
        await summarizeYouTubeAndInsert(plugin, editor, transcript, videoInfo, personaPrompt, transcriptPath, userContext);
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
    userContext?: string
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
    userContext?: string
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
 * Summarize PDF content and insert into editor
 */
async function summarizePdfContent(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    pdfContent: PdfContent,
    personaPrompt: string,
    userContext: string | undefined,
    isInternal: boolean
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
