/**
 * Translate Commands
 * Commands for translating note content and multi-source content
 */

import { Editor, MarkdownView, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { TranslateModal } from '../ui/modals/TranslateModal';
import { MultiSourceModal, MultiSourceModalResult } from '../ui/modals/MultiSourceModal';
import { buildTranslatePrompt, insertContentIntoTranslatePrompt } from '../services/prompts/translatePrompts';
import {
    replaceMainContent,
    ensureNoteStructureIfEnabled,
    addToReferencesSection,
    SourceReference,
    SourceType,
    getTodayDate
} from '../utils/noteStructure';
import { summarizeText } from '../services/llmFacade';
import { detectSourcesFromContent, hasAnySources, removeProcessedSources } from '../utils/sourceDetection';
import { fetchArticle, chunkContent } from '../services/webContentService';
import { getMaxContentChars } from '../services/tokenLimits';
import { ensurePrivacyConsent } from '../services/privacyNotice';
import { PdfService } from '../services/pdfService';
import { DocumentExtractionService } from '../services/documentExtractionService';
import { getYouTubeGeminiApiKey, getAudioTranscriptionApiKey } from '../services/apiKeyHelpers';
import { translatePdfWithLLM } from '../services/pdfTranslationService';
import {
    transcribeYouTubeWithGemini,
    summarizeYouTubeWithGemini
} from '../services/youtubeService';
import {
    transcribeAudioWithFullWorkflow,
    AudioWorkflowProgress
} from '../services/audioTranscriptionService';

/**
 * Processed source tracking for translate orchestrator
 */
interface TranslatedSource {
    type: 'web' | 'youtube' | 'note' | 'pdf' | 'document' | 'audio';
    url?: string;
    title: string;
    date: string;
    success: boolean;
    translation?: string;
    error?: string;
}

export function registerTranslateCommands(plugin: AIOrganiserPlugin): void {
    // Command: Translate (smart dispatcher)
    // Uses callback (not editorCallback) so it works from CommandPickerModal via executeCommandById
    plugin.addCommand({
        id: 'smart-translate',
        name: plugin.t.commands.translate || plugin.t.commands.translateNote || 'Translate',
        icon: 'languages',
        callback: async () => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view?.file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }
            const editor = view.editor;
            const selection = editor.getSelection();
            const hasSelection = !!selection.trim();
            const content = editor.getValue();

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContent);
                return;
            }

            if (hasSelection) {
                // Selection present → simple TranslateModal → translateSelection
                const modal = new TranslateModal(
                    plugin.app,
                    plugin.t,
                    async (result) => {
                        await translateSelection(plugin, editor, selection, result.targetLanguageName);
                    }
                );
                modal.open();
                return;
            }

            // No selection → check for multi-source content
            const detectedSources = detectSourcesFromContent(content, plugin.app);

            if (hasAnySources(detectedSources)) {
                // Sources detected → MultiSourceModal in translate mode
                const modal = new MultiSourceModal(
                    plugin.app,
                    plugin,
                    content,
                    async (result: MultiSourceModalResult) => {
                        try {
                            const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                            if (!activeView) {
                                new Notice(plugin.t.messages.openNote);
                                return;
                            }
                            await handleMultiSourceTranslate(plugin, editor, activeView, result);
                        } catch (e) {
                            console.error('Error in handleMultiSourceTranslate:', e);
                            new Notice(plugin.t.messages.errorGeneric.replace('{error}', e instanceof Error ? e.message : 'Unknown error'));
                        }
                    },
                    {
                        mode: 'translate',
                        hidePersona: true,
                        hideFocusContext: true,
                        showLanguageSelector: true,
                        ctaLabel: plugin.t.modals?.multiSource?.translateButton || 'Translate'
                    }
                );
                modal.open();
            } else {
                // No sources → simple TranslateModal → translateNote
                const modal = new TranslateModal(
                    plugin.app,
                    plugin.t,
                    async (result) => {
                        await translateNote(
                            plugin,
                            editor,
                            content,
                            result.targetLanguageName,
                            plugin.t.messages.translatingFullNote
                        );
                    }
                );
                modal.open();
            }
        }
    });
}

/**
 * Translate entire note content
 */
async function translateNote(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    content: string,
    targetLanguage: string,
    noticeMessage?: string
): Promise<void> {
    new Notice(noticeMessage || plugin.t.messages.translating);

    const promptTemplate = buildTranslatePrompt({ targetLanguage });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, content);

    try {
        const response = await translateWithLLM(plugin, prompt);

        if (response.success && response.content) {
            // Replace main content while preserving References and Pending Integration sections
            replaceMainContent(editor, response.content);

            // Ensure standard structure exists after translation
            ensureNoteStructureIfEnabled(editor, plugin.settings);

            new Notice(plugin.t.messages.noteTranslatedSuccess, 3000);
        } else {
            new Notice(`${plugin.t.messages.translationFailed}: ${response.error || plugin.t.messages.unknownError}`, 5000);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : plugin.t.messages.unknownError;
        new Notice(`${plugin.t.messages.translationFailed}: ${errorMessage}`, 5000);
    }
}

/**
 * Translate selected text
 */
async function translateSelection(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    selection: string,
    targetLanguage: string
): Promise<void> {
    new Notice(plugin.t.messages.translating);

    const promptTemplate = buildTranslatePrompt({ targetLanguage });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, selection);

    try {
        const response = await translateWithLLM(plugin, prompt);

        if (response.success && response.content) {
            // Replace selection with translated content
            editor.replaceSelection(response.content);
            ensureNoteStructureIfEnabled(editor, plugin.settings);
            new Notice(plugin.t.messages.selectionTranslatedSuccess, 3000);
        } else {
            new Notice(`${plugin.t.messages.translationFailed}: ${response.error || plugin.t.messages.unknownError}`, 5000);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : plugin.t.messages.unknownError;
        new Notice(`${plugin.t.messages.translationFailed}: ${errorMessage}`, 5000);
    }
}

/**
 * Call LLM service for translation
 */
async function translateWithLLM(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    return await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, prompt);
}

// ─── Multi-Source Translation ───────────────────────────────────────

/**
 * Handle multi-source translate result from MultiSourceModal
 * Orchestrates sequential extraction + translation of each source
 */
async function handleMultiSourceTranslate(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView,
    result: MultiSourceModalResult
): Promise<void> {
    const targetLanguage = result.targetLanguageName || 'English';

    // Count total sources
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

    // Single-source optimization: note-only → use existing translateNote()
    if (totalSources === 1 && result.summarizeNote) {
        const content = editor.getValue();
        await translateNote(plugin, editor, content, targetLanguage, plugin.t.messages.translatingFullNote);
        return;
    }

    // Resolve service type once
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Privacy consent once upfront (for external content)
    const hasExternalSources =
        result.sources.urls.length > 0 ||
        result.sources.youtube.length > 0 ||
        result.sources.pdfs.some(p => !p.isVaultFile) ||
        result.sources.documents.some(d => !d.isVaultFile);

    if (hasExternalSources) {
        const consentGiven = await ensurePrivacyConsent(plugin, serviceType);
        if (!consentGiven) {
            return;
        }
    }

    // Begin multi-source processing
    new Notice(
        (plugin.t.messages.translatingMultipleSources || 'Translating {count} sources...')
            .replace('{count}', String(totalSources)),
        3000
    );

    const allSources: TranslatedSource[] = [];
    const today = getTodayDate();
    let processedCount = 0;

    const showProgress = () => {
        const msg = (plugin.t.messages.translatingSourceProgress || 'Translating {current}/{total}...')
            .replace('{current}', String(processedCount + 1))
            .replace('{total}', String(totalSources));
        new Notice(msg, 3000);
    };

    // ── Process note content first ──
    if (result.summarizeNote && view.file) {
        showProgress();
        try {
            // Use editor buffer (not vault.read) to capture unsaved edits
            const noteContent = editor.getValue();
            new Notice(plugin.t.messages.translatingFullNote || 'Translating note...', 5000);
            const translated = await translateSourceContent(plugin, noteContent, targetLanguage, serviceType);
            allSources.push({
                type: 'note',
                title: view.file.basename,
                date: today,
                success: !!translated,
                translation: translated || undefined,
                error: translated ? undefined : 'Failed to translate note content'
            });
        } catch (e) {
            console.error('Failed to translate note:', e);
            allSources.push({
                type: 'note',
                title: view.file.basename,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
        }
        processedCount++;
    }

    // ── Process URLs ──
    for (const url of result.sources.urls) {
        showProgress();
        try {
            const translated = await extractAndTranslateUrl(plugin, url, targetLanguage, serviceType);
            allSources.push(translated);
        } catch (e) {
            console.error(`Failed to translate URL ${url}:`, e);
            allSources.push({
                type: 'web',
                url,
                title: url,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Network error'
            });
        }
        processedCount++;
    }

    // ── Process YouTube videos ──
    for (const url of result.sources.youtube) {
        showProgress();
        try {
            const translated = await extractAndTranslateYouTube(plugin, url, targetLanguage, serviceType);
            allSources.push(translated);
        } catch (e) {
            console.error(`Failed to translate YouTube ${url}:`, e);
            allSources.push({
                type: 'youtube',
                url,
                title: url,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Could not process video'
            });
        }
        processedCount++;
    }

    // ── Process PDFs ──
    const pdfService = new PdfService(plugin.app);
    for (const pdf of result.sources.pdfs) {
        showProgress();
        const pdfTitle = pdf.path.split('/').pop() || pdf.path;
        try {
            const translated = await extractAndTranslatePdf(
                plugin, pdfService, pdf.path, pdf.isVaultFile, targetLanguage, serviceType, view.file?.path
            );
            allSources.push(translated);
        } catch (e) {
            console.error('Error translating PDF:', e);
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

    // ── Process Documents ──
    for (const doc of result.sources.documents) {
        showProgress();
        const docTitle = doc.path.split('/').pop() || doc.path;
        try {
            const translated = await extractAndTranslateDocument(
                plugin, view, doc.path, doc.isVaultFile, targetLanguage, serviceType
            );
            allSources.push(translated);
        } catch (e) {
            console.error('Error translating document:', e);
            allSources.push({
                type: 'document',
                url: doc.path,
                title: docTitle,
                date: today,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
            });
        }
        processedCount++;
    }

    // ── Process Audio files ──
    const audioTranscriptionConfig = await getAudioTranscriptionApiKey(plugin);
    for (const audio of result.sources.audio) {
        showProgress();
        const audioTitle = audio.path.split('/').pop() || audio.path;
        try {
            const translated = await extractAndTranslateAudio(
                plugin, view, audio.path, audio.isVaultFile, targetLanguage, serviceType, audioTranscriptionConfig
            );
            allSources.push(translated);
        } catch (e) {
            console.error('Error translating audio:', e);
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

    // ── Assemble output ──
    assembleTranslatedOutput(plugin, editor, view, result, allSources);
}

// ─── Source Extraction + Translation Functions ──────────────────────

/**
 * Translate text content with chunking support
 */
async function translateSourceContent(
    plugin: AIOrganiserPlugin,
    text: string,
    targetLanguage: string,
    serviceType: string,
    sourceType?: string,
    sourceTitle?: string
): Promise<string | null> {
    const maxChars = getMaxContentChars(serviceType);

    if (text.length > maxChars) {
        // Chunk and translate each piece
        const chunks = chunkContent(text, maxChars);
        const translatedChunks: string[] = [];
        for (const chunk of chunks) {
            const promptTemplate = buildTranslatePrompt({ targetLanguage, sourceType, sourceTitle });
            const prompt = insertContentIntoTranslatePrompt(promptTemplate, chunk);
            const response = await translateWithLLM(plugin, prompt);
            if (response.success && response.content) {
                translatedChunks.push(response.content);
            } else {
                // If any chunk fails, return null
                return null;
            }
        }
        return translatedChunks.join('\n\n');
    }

    const promptTemplate = buildTranslatePrompt({ targetLanguage, sourceType, sourceTitle });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, text);
    const response = await translateWithLLM(plugin, prompt);
    return response.success && response.content ? response.content : null;
}

/**
 * Fetch web article and translate
 */
async function extractAndTranslateUrl(
    plugin: AIOrganiserPlugin,
    url: string,
    targetLanguage: string,
    serviceType: string
): Promise<TranslatedSource> {
    const today = getTodayDate();

    new Notice(
        (plugin.t.messages.extractingForTranslation || 'Extracting content for translation...'),
        3000
    );

    const webResult = await fetchArticle(url);
    if (!webResult.success || !webResult.content) {
        return {
            type: 'web',
            url,
            title: url,
            date: today,
            success: false,
            error: webResult.error || 'Could not fetch page (may require login or JavaScript)'
        };
    }

    const title = webResult.content.title || url;
    const translated = await translateSourceContent(
        plugin, webResult.content.textContent, targetLanguage, serviceType, 'web article', title
    );

    return {
        type: 'web',
        url,
        title,
        date: today,
        success: !!translated,
        translation: translated || undefined,
        error: translated ? undefined : 'Failed to translate web content'
    };
}

/**
 * Get YouTube transcript and translate
 * Uses Gemini for transcript extraction, then translates the text
 */
async function extractAndTranslateYouTube(
    plugin: AIOrganiserPlugin,
    url: string,
    targetLanguage: string,
    serviceType: string
): Promise<TranslatedSource> {
    const today = getTodayDate();

    const geminiKey = await getYouTubeGeminiApiKey(plugin);
    if (!geminiKey) {
        return {
            type: 'youtube',
            url,
            title: url,
            date: today,
            success: false,
            error: 'Configure Gemini API key in Settings > YouTube to enable video processing'
        };
    }

    new Notice(plugin.t.messages.processingYouTubeWithGemini || 'Processing YouTube video...', 5000);

    // Use transcribeYouTubeWithGemini to get the transcript text (not a summary)
    const transcriptResult = await transcribeYouTubeWithGemini(
        url,
        geminiKey,
        plugin.settings.youtubeGeminiModel,
        plugin.settings.summarizeTimeoutSeconds * 1000
    );

    if (!transcriptResult.success || !transcriptResult.transcript) {
        // Fallback: try summarizeYouTubeWithGemini which can also get content
        // Build a translation prompt and let Gemini handle the full flow
        const promptTemplate = buildTranslatePrompt({ targetLanguage, sourceType: 'YouTube video' });
        const prompt = insertContentIntoTranslatePrompt(promptTemplate, 'Please translate the content of this video.');

        const geminiResult = await summarizeYouTubeWithGemini(
            url,
            geminiKey,
            prompt,
            plugin.settings.youtubeGeminiModel,
            plugin.settings.summarizeTimeoutSeconds * 1000
        );

        const title = geminiResult.videoInfo?.title || url;
        if (geminiResult.success && geminiResult.content) {
            return {
                type: 'youtube',
                url,
                title,
                date: today,
                success: true,
                translation: geminiResult.content
            };
        }

        return {
            type: 'youtube',
            url,
            title,
            date: today,
            success: false,
            error: geminiResult.error || transcriptResult.error || 'Failed to process YouTube video'
        };
    }

    // Got transcript - translate it
    const title = transcriptResult.videoInfo?.title || url;
    const translated = await translateSourceContent(
        plugin, transcriptResult.transcript, targetLanguage, serviceType, 'YouTube transcript', title
    );

    return {
        type: 'youtube',
        url,
        title,
        date: today,
        success: !!translated,
        translation: translated || undefined,
        error: translated ? undefined : 'Failed to translate YouTube transcript'
    };
}

/**
 * Extract PDF content and translate (two-tier: text extraction → multimodal fallback)
 */
async function extractAndTranslatePdf(
    plugin: AIOrganiserPlugin,
    pdfService: PdfService,
    pdfPath: string,
    isVaultFile: boolean,
    targetLanguage: string,
    serviceType: string,
    currentFilePath?: string
): Promise<TranslatedSource> {
    const today = getTodayDate();
    const pdfTitle = pdfPath.split('/').pop() || pdfPath;

    new Notice(
        (plugin.t.messages.extractingForTranslation || 'Extracting content for translation...')
            .replace('{title}', pdfTitle),
        3000
    );

    // Tier 1: Try text extraction via DocumentExtractionService
    const documentService = new DocumentExtractionService(plugin.app);
    let extractedText: string | null = null;

    if (isVaultFile) {
        let file = plugin.app.metadataCache.getFirstLinkpathDest(pdfPath, currentFilePath || '');
        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(pdfPath);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }
        if (file) {
            try {
                const result = await documentService.extractText(file);
                if (result.success && result.text && result.text.trim().length > 50) {
                    extractedText = result.text;
                }
            } catch {
                // Text extraction failed - will try multimodal
            }
        }
    }

    if (extractedText) {
        // Text-extractable PDF - translate via chunking
        const translated = await translateSourceContent(
            plugin, extractedText, targetLanguage, serviceType, 'PDF document', pdfTitle
        );
        return {
            type: 'pdf',
            url: pdfPath,
            title: pdfTitle,
            date: today,
            success: !!translated,
            translation: translated || undefined,
            error: translated ? undefined : 'Failed to translate PDF text'
        };
    }

    // Tier 2: Multimodal PDF translation via base64
    let pdfResult;
    if (isVaultFile) {
        let file = plugin.app.metadataCache.getFirstLinkpathDest(pdfPath, currentFilePath || '');
        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(pdfPath);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }
        if (!file || !(file instanceof TFile)) {
            return {
                type: 'pdf',
                url: pdfPath,
                title: pdfTitle,
                date: today,
                success: false,
                error: 'Could not find PDF file in vault'
            };
        }
        pdfResult = await pdfService.readPdfAsBase64(file);
    } else {
        pdfResult = await pdfService.readExternalPdfAsBase64(pdfPath);
    }

    if (!pdfResult.success || !pdfResult.content) {
        return {
            type: 'pdf',
            url: pdfPath,
            title: pdfTitle,
            date: today,
            success: false,
            error: pdfResult.error || 'Failed to read PDF'
        };
    }

    // Build translate prompt for multimodal
    const promptTemplate = buildTranslatePrompt({ targetLanguage, sourceType: 'PDF document', sourceTitle: pdfTitle });
    const prompt = insertContentIntoTranslatePrompt(promptTemplate, 'Please translate the content of this PDF document.');

    const response = await translatePdfWithLLM(plugin, pdfResult.content, prompt);

    return {
        type: 'pdf',
        url: pdfPath,
        title: pdfTitle,
        date: today,
        success: response.success && !!response.content,
        translation: response.content || undefined,
        error: response.success ? undefined : (response.error || 'Failed to translate PDF via multimodal')
    };
}

/**
 * Extract document text and translate (docx, xlsx, pptx, txt, rtf)
 */
async function extractAndTranslateDocument(
    plugin: AIOrganiserPlugin,
    view: MarkdownView,
    docPath: string,
    isVaultFile: boolean,
    targetLanguage: string,
    serviceType: string
): Promise<TranslatedSource> {
    const today = getTodayDate();
    const docTitle = docPath.split('/').pop() || docPath;

    new Notice(
        (plugin.t.messages.extractingForTranslation || 'Extracting content for translation...')
            .replace('{title}', docTitle),
        3000
    );

    const documentService = new DocumentExtractionService(plugin.app);

    if (isVaultFile) {
        const currentFile = view.file;
        let file = plugin.app.metadataCache.getFirstLinkpathDest(docPath, currentFile?.path || '');
        if (!file) {
            const directFile = plugin.app.vault.getAbstractFileByPath(docPath);
            if (directFile instanceof TFile) {
                file = directFile;
            }
        }
        if (!file) {
            return {
                type: 'document',
                url: docPath,
                title: docTitle,
                date: today,
                success: false,
                error: 'Document file not found in vault'
            };
        }

        const result = await documentService.extractText(file);
        if (!result.success || !result.text) {
            return {
                type: 'document',
                url: docPath,
                title: docTitle,
                date: today,
                success: false,
                error: result.error || 'Failed to extract document text'
            };
        }

        const translated = await translateSourceContent(
            plugin, result.text, targetLanguage, serviceType, 'document', docTitle
        );
        return {
            type: 'document',
            url: docPath,
            title: docTitle,
            date: today,
            success: !!translated,
            translation: translated || undefined,
            error: translated ? undefined : 'Failed to translate document'
        };
    }

    // External document
    const progressNotice = (status: string) => {
        new Notice(status, 2000);
    };
    const result = await documentService.extractFromUrl(docPath, progressNotice);
    if (!result.success || !result.text) {
        return {
            type: 'document',
            url: docPath,
            title: docTitle,
            date: today,
            success: false,
            error: result.error || 'Failed to extract document from URL'
        };
    }

    const translated = await translateSourceContent(
        plugin, result.text, targetLanguage, serviceType, 'document', docTitle
    );
    return {
        type: 'document',
        url: docPath,
        title: docTitle,
        date: today,
        success: !!translated,
        translation: translated || undefined,
        error: translated ? undefined : 'Failed to translate document'
    };
}

/**
 * Transcribe audio and translate the transcript
 */
async function extractAndTranslateAudio(
    plugin: AIOrganiserPlugin,
    view: MarkdownView,
    audioPath: string,
    isVaultFile: boolean,
    targetLanguage: string,
    serviceType: string,
    audioConfig: { key: string; provider: 'openai' | 'groq' } | null
): Promise<TranslatedSource> {
    const today = getTodayDate();
    const audioTitle = audioPath.split('/').pop() || audioPath;

    if (!audioConfig) {
        return {
            type: 'audio',
            url: audioPath,
            title: audioTitle,
            date: today,
            success: false,
            error: plugin.t.messages.audioTranscriptionKeyMissing ||
                'Audio transcription requires OpenAI or Groq API key. Configure in Settings > Audio Transcription.'
        };
    }

    if (!isVaultFile) {
        return {
            type: 'audio',
            url: audioPath,
            title: audioTitle,
            date: today,
            success: false,
            error: 'External audio files not supported in multi-source mode'
        };
    }

    // Resolve audio file using link resolution
    const currentFile = view.file;
    let audioFile = plugin.app.metadataCache.getFirstLinkpathDest(audioPath, currentFile?.path || '');
    if (!audioFile) {
        const directFile = plugin.app.vault.getAbstractFileByPath(audioPath);
        if (directFile instanceof TFile) {
            audioFile = directFile;
        }
    }

    if (!(audioFile instanceof TFile)) {
        return {
            type: 'audio',
            url: audioPath,
            title: audioTitle,
            date: today,
            success: false,
            error: 'Could not find audio file in vault'
        };
    }

    // Transcribe using unified workflow
    new Notice(
        (plugin.t.messages.transcribingForTranslation || 'Transcribing audio for translation...'),
        3000
    );

    const transcriptionResult = await transcribeAudioWithFullWorkflow(
        plugin.app,
        audioFile,
        {
            provider: audioConfig.provider,
            apiKey: audioConfig.key,
            language: plugin.settings.summaryLanguage || undefined
        },
        (progress: AudioWorkflowProgress) => {
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
    );

    if (!transcriptionResult.success || !transcriptionResult.transcript) {
        return {
            type: 'audio',
            url: audioPath,
            title: audioTitle,
            date: today,
            success: false,
            error: transcriptionResult.error || 'Failed to transcribe audio'
        };
    }

    // Translate the transcript
    const translated = await translateSourceContent(
        plugin, transcriptionResult.transcript, targetLanguage, serviceType, 'audio transcript', audioTitle
    );

    return {
        type: 'audio',
        url: audioPath,
        title: audioTitle,
        date: today,
        success: !!translated,
        translation: translated || undefined,
        error: translated ? undefined : 'Failed to translate audio transcript'
    };
}

// ─── Output Assembly ────────────────────────────────────────────────

/**
 * Assemble final note with translated content + references
 */
function assembleTranslatedOutput(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    view: MarkdownView,
    result: MultiSourceModalResult,
    allSources: TranslatedSource[]
): void {
    const successCount = allSources.filter(s => s.success).length;

    if (successCount === 0) {
        // All failed
        const errors = allSources.map(s => `${s.title}: ${s.error || 'Failed'}`).join('\n');
        new Notice(
            (plugin.t.messages.translationFailed || 'Translation failed') + ': ' +
            (allSources[0]?.error || 'No sources could be translated'),
            8000
        );
        console.error('All translation sources failed:', errors);
        return;
    }

    // Separate note translation from external source translations
    const noteSource = allSources.find(s => s.type === 'note');
    const externalSources = allSources.filter(s => s.type !== 'note');

    // Step 1: Replace note content if note was translated
    if (noteSource?.success && noteSource.translation) {
        replaceMainContent(editor, noteSource.translation);
    }

    // Step 2: Append translated external source sections
    const successfulExternal = externalSources.filter(s => s.success && s.translation);
    if (successfulExternal.length > 0) {
        let appendContent = '';
        for (const source of successfulExternal) {
            appendContent += `\n\n## Translated: ${source.title}\n\n${source.translation}`;
        }

        // Insert before References section (or at end of main content)
        const fullContent = editor.getValue();
        const refIndex = fullContent.indexOf('\n## References');
        const pendingIndex = fullContent.indexOf('\n## Pending Integration');

        // Find the earliest structural section to insert before
        let insertIndex = fullContent.length;
        if (refIndex > -1 && refIndex < insertIndex) insertIndex = refIndex;
        if (pendingIndex > -1 && pendingIndex < insertIndex) insertIndex = pendingIndex;

        // Check for horizontal rule before References
        const hrBeforeRef = fullContent.lastIndexOf('\n---\n', insertIndex);
        if (hrBeforeRef > -1 && insertIndex - hrBeforeRef < 10) {
            insertIndex = hrBeforeRef;
        }

        const newContent = fullContent.substring(0, insertIndex) + appendContent + fullContent.substring(insertIndex);
        editor.setValue(newContent);
    }

    // Step 3: Remove processed source URLs and vault wikilinks from note body
    // Build vault file paths list (reused for cleanup and references)
    const vaultFilePathsList = [
        ...result.sources.pdfs.filter(p => p.isVaultFile).map(p => p.path),
        ...result.sources.documents.filter(d => d.isVaultFile).map(d => d.path),
        ...result.sources.audio.filter(a => a.isVaultFile).map(a => a.path),
    ];
    const vaultFilePaths = new Set<string>(vaultFilePathsList);

    const urlsToRemove = allSources
        .filter(s => s.url && s.type !== 'note' && s.success)
        .map(s => s.url as string);

    if (urlsToRemove.length > 0 || vaultFilePathsList.length > 0) {
        const currentContent = editor.getValue();
        const cleanedContent = removeProcessedSources(currentContent, urlsToRemove, vaultFilePathsList);
        if (cleanedContent !== currentContent) {
            editor.setValue(cleanedContent);
        }
    }

    // Step 4: Add references for each successful source

    for (const source of allSources) {
        if (source.url && source.success && source.type !== 'note') {
            // Map TranslatedSource.type to SourceType properly
            const refType: SourceType =
                source.type === 'web' ? 'web' :
                source.type === 'youtube' ? 'youtube' :
                source.type === 'pdf' ? 'pdf' :
                source.type === 'audio' ? 'audio' :
                source.type === 'document' ? 'document' :
                'note';

            const isInternal = vaultFilePaths.has(source.url);
            const link = source.url; // Raw path — formatSourceReference() adds [[]] for internal

            const sourceRef: SourceReference = {
                type: refType,
                title: source.title,
                link,
                date: source.date,
                isInternal
            };
            addToReferencesSection(editor, sourceRef);
        }
    }

    // Step 5: Ensure note structure
    ensureNoteStructureIfEnabled(editor, plugin.settings);

    // Step 6: Show completion notice
    const totalCount = allSources.length;
    if (successCount === totalCount) {
        new Notice(
            (plugin.t.messages.multiSourceTranslateComplete || 'Translation complete!'),
            3000
        );
    } else {
        new Notice(
            (plugin.t.messages.multiSourceTranslatePartial || '{success} of {total} sources translated')
                .replace('{success}', String(successCount))
                .replace('{total}', String(totalCount)),
            5000
        );
    }
}
