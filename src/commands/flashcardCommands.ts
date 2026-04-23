/**
 * Flashcard Commands
 * Commands for generating and exporting flashcards from notes.
 * Supports three source types: current note, multiple notes, and screenshot.
 * Current-note and multi-note sources auto-detect embedded images and use
 * the multimodal pipeline when the provider supports vision.
 */

import { MarkdownView, Notice, Platform, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { FlashcardExportModal, type FlashcardExportResult } from '../ui/modals/FlashcardExportModal';
import {
    buildFlashcardPrompt,
    buildScreenshotFlashcardPrompt,
    validateFlashcardCSV,
    cardsToCSV,
    type FlashcardFormat
} from '../services/prompts/flashcardPrompts';
import { summarizeText, sendMultimodal, getServiceType, pluginContext, isMultimodalService } from '../services/llmFacade';
import { withProgress } from '../services/progress';
import { desktopRequire, getFs, getPath, getOs } from '../utils/desktopRequire';
import type { ContentPart } from '../services/adapters/types';
import { detectEmbeddedContent } from '../utils/embeddedContentDetector';
import { withBusyIndicator } from '../utils/busyIndicator';
import { getMaxContentChars } from '../services/tokenLimits';
import { ImageProcessorService } from '../services/imageProcessorService';
import { VisionService } from '../services/visionService';
import { ensurePrivacyConsent } from '../services/privacyNotice';
import { getFlashcardProviderConfig } from '../services/apiKeyHelpers';
import { CloudLLMService } from '../services/cloudService';

/**
 * Register flashcard-related commands
 */
export function registerFlashcardCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'export-flashcards',
        name: plugin.t.commands.exportFlashcards || 'Export flashcards from current note',
        icon: 'layers',
        callback: () => exportFlashcards(plugin)
    });
}

/**
 * Export flashcards — opens modal, dispatches to correct source handler.
 */
export function exportFlashcards(plugin: AIOrganiserPlugin): void {
    const visionService = new VisionService(plugin);
    const visionSupported = visionService.canDigitise().supported;

    new FlashcardExportModal(
        plugin.app,
        plugin.t,
        visionSupported,
        async (result: FlashcardExportResult) => {
            switch (result.source) {
                case 'current-note':
                    await handleCurrentNoteSource(plugin, result);
                    break;
                case 'multiple-notes':
                    await handleMultiNoteSource(plugin, result);
                    break;
                case 'screenshot':
                    await handleScreenshotSource(plugin, result);
                    break;
            }
        }
    ).open();
}

// ─── Source handlers ────────────────────────────────────────────────

/**
 * Handle 'current-note' source.
 * Auto-detects embedded images and uses multimodal pipeline when available.
 */
async function handleCurrentNoteSource(
    plugin: AIOrganiserPlugin,
    result: FlashcardExportResult & { source: 'current-note' }
): Promise<void> {
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice(plugin.t.messages.openNoteFirst || 'Please open a note first');
        return;
    }

    const content = await getEditorContent(plugin, activeFile);
    if (!content.trim()) {
        new Notice(plugin.t.messages.noContentToAnalyze || 'Note has no content to analyze');
        return;
    }

    // Detect embedded images and use multimodal if available
    const embeddedImages = resolveEmbeddedImages(plugin, content, activeFile);
    if (embeddedImages.length > 0 && isVisionAvailable(plugin)) {
        await generateFlashcardsWithImages(plugin, content, embeddedImages, activeFile.basename, result);
    } else {
        await generateAndExportFlashcards(plugin, content, activeFile.basename, result);
    }
}

/**
 * Handle 'multiple-notes' source: assemble content with size guardrails
 */
async function handleMultiNoteSource(
    plugin: AIOrganiserPlugin,
    result: FlashcardExportResult & { source: 'multiple-notes' }
): Promise<void> {
    const { content, wasTruncated } = await assembleMultiNoteContent(plugin, result.selectedNotes);

    if (!content.trim()) {
        new Notice(plugin.t.messages.noContentToAnalyze || 'Notes have no content to analyze');
        return;
    }

    if (wasTruncated) {
        const truncMsg = plugin.t.modals.flashcardExport?.contentTruncated
            || 'Some content was truncated to fit provider limits';
        new Notice(truncMsg, 4000);
    }

    await generateAndExportFlashcards(plugin, content, 'multi-note-flashcards', result);
}

/**
 * Handle 'screenshot' source: vision LLM transcribes + answers MC questions
 */
async function handleScreenshotSource(
    plugin: AIOrganiserPlugin,
    result: FlashcardExportResult & { source: 'screenshot' }
): Promise<void> {
    // Runtime capability check (modal warned, but command handler is the authority)
    const visionService = new VisionService(plugin);
    const capability = visionService.canDigitise();
    if (!capability.supported) {
        new Notice(capability.reason || 'Vision not supported by current provider', 5000);
        return;
    }

    // Privacy consent — use dedicated flashcard provider if configured
    const flashcardConfig = await getFlashcardProviderConfig(plugin);
    const providerName = flashcardConfig?.provider ?? getServiceType(pluginContext(plugin)).provider;
    const consented = await ensurePrivacyConsent(plugin, providerName);
    if (!consented) return;

    await generateFlashcardsFromScreenshot(plugin, result);
}

// ─── Core generation functions ──────────────────────────────────────

/**
 * Generate flashcards from text content (current-note or multi-note, no images)
 */
async function generateAndExportFlashcards(
    plugin: AIOrganiserPlugin,
    content: string,
    baseName: string,
    options: FlashcardExportResult
): Promise<void> {
    const { format, context } = options;
    const style = 'style' in options ? options.style : 'multiple-choice';
    const t = plugin.t.messages;
    const tp = plugin.t.progress;

    type Phase = 'generating' | 'validating' | 'saving';

    type FlashcardResult = { csv: string; cardCount: number; validationFailed?: {
        errors: string[]; csvContent: string;
    } };

    const r = await withProgress<FlashcardResult, Phase>(
        {
            plugin,
            initialPhase: { key: 'generating' },
            resolvePhase: (p) => {
                const tmpl = tp.flashcards[p.key];
                if (!p.params) return tmpl;
                return Object.entries(p.params).reduce(
                    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
                    tmpl,
                );
            },
        },
        async (reporter) => {
            const prompt = buildFlashcardPrompt(
                content,
                format,
                context,
                plugin.settings.summaryLanguage || undefined,
                style,
            );

            const response = await callLLMForFlashcards(plugin, prompt);
            if (!response.success || !response.content) {
                throw new Error(response.error || 'Empty response from LLM');
            }

            reporter.setPhase({ key: 'validating' });
            const csvContent = cleanCSVResponse(response.content);
            const validation = validateFlashcardCSV(csvContent);

            if (!validation.valid || validation.cardCount === 0) {
                // Not a failure — let the caller show the validation error
                // modal. Reporter will succeed cleanly; caller decides what
                // to render to the user.
                return { csv: '', cardCount: 0, validationFailed: { errors: validation.errors, csvContent } };
            }

            reporter.setPhase({ key: 'saving', params: { count: validation.cardCount } });
            return { csv: cardsToCSV(validation.cards), cardCount: validation.cardCount };
        },
    );
    if (!r.ok) return; // reporter showed toast

    if (r.value.validationFailed) {
        showCSVValidationError(t, r.value.validationFailed.csvContent, r.value.validationFailed.errors);
        return;
    }
    await deliverFlashcards(plugin, r.value.csv, baseName, format, r.value.cardCount);
}

/**
 * Generate flashcards from text + embedded images via multimodal pipeline.
 * Sends the note text together with all embedded images as ContentParts.
 */
async function generateFlashcardsWithImages(
    plugin: AIOrganiserPlugin,
    content: string,
    imageFiles: TFile[],
    baseName: string,
    options: FlashcardExportResult
): Promise<void> {
    const { format, context } = options;
    const style = 'style' in options ? options.style : 'multiple-choice';
    const t = plugin.t.messages;
    const tp = plugin.t.progress;

    // Privacy consent — use dedicated flashcard provider if configured
    const flashcardConfig = await getFlashcardProviderConfig(plugin);
    const providerName = flashcardConfig?.provider ?? getServiceType(pluginContext(plugin)).provider;
    const consented = await ensurePrivacyConsent(plugin, providerName);
    if (!consented) return;

    type Phase = 'generating' | 'validating' | 'saving';
    type FlashcardResult = { csv: string; cardCount: number; validationFailed?: {
        errors: string[]; csvContent: string;
    } };

    const r = await withProgress<FlashcardResult, Phase>(
        {
            plugin,
            initialPhase: { key: 'generating' },
            resolvePhase: (p) => {
                const tmpl = tp.flashcards[p.key];
                if (!p.params) return tmpl;
                return Object.entries(p.params).reduce(
                    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
                    tmpl,
                );
            },
        },
        async (reporter) => {
            const imageProcessor = new ImageProcessorService(plugin.app);

            const prompt = buildFlashcardPrompt(
                content,
                format,
                context,
                plugin.settings.summaryLanguage || undefined,
                style,
            );

            const parts: ContentPart[] = [{ type: 'text', text: prompt }];

            for (const imgFile of imageFiles) {
                try {
                    const processed = await imageProcessor.processImage(imgFile, {
                        maxDimension: plugin.settings.digitiseMaxDimension,
                        quality: plugin.settings.digitiseImageQuality,
                    });
                    parts.push({ type: 'image', data: processed.base64, mediaType: processed.mediaType });
                } catch (err) {
                    logger.warn('Export', `Failed to process embedded image ${imgFile.path}:`, err);
                }
            }

            const response = await sendMultimodalForFlashcards(plugin, parts, { maxTokens: 4000 });
            if (!response.success || !response.content) {
                throw new Error(response.error || 'Empty response from vision LLM');
            }

            reporter.setPhase({ key: 'validating' });
            const csvContent = cleanCSVResponse(response.content);
            const validation = validateFlashcardCSV(csvContent);

            if (!validation.valid || validation.cardCount === 0) {
                return { csv: '', cardCount: 0, validationFailed: { errors: validation.errors, csvContent } };
            }

            reporter.setPhase({ key: 'saving', params: { count: validation.cardCount } });
            return { csv: cardsToCSV(validation.cards), cardCount: validation.cardCount };
        },
    );
    if (!r.ok) return;

    if (r.value.validationFailed) {
        showCSVValidationError(t, r.value.validationFailed.csvContent, r.value.validationFailed.errors);
        return;
    }
    await deliverFlashcards(plugin, r.value.csv, baseName, format, r.value.cardCount);
}

/**
 * Generate flashcards from a screenshot via vision LLM
 */
async function generateFlashcardsFromScreenshot(
    plugin: AIOrganiserPlugin,
    result: FlashcardExportResult & { source: 'screenshot' }
): Promise<void> {
    const { format, context, imageFile } = result;
    const t = plugin.t.messages;
    const tp = plugin.t.progress;

    type Phase = 'generating' | 'validating' | 'saving';
    type FlashcardResult = { csv: string; cardCount: number; baseName: string; validationFailed?: {
        errors: string[]; csvContent: string;
    } };

    const r = await withProgress<FlashcardResult, Phase>(
        {
            plugin,
            initialPhase: { key: 'generating' },
            resolvePhase: (p) => {
                const tmpl = tp.flashcards[p.key];
                if (!p.params) return tmpl;
                return Object.entries(p.params).reduce(
                    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
                    tmpl,
                );
            },
        },
        async (reporter) => {
            const imageProcessor = new ImageProcessorService(plugin.app);
            const processed = await imageProcessor.processImage(imageFile, {
                maxDimension: plugin.settings.digitiseMaxDimension,
                quality: plugin.settings.digitiseImageQuality,
            });

            const prompt = buildScreenshotFlashcardPrompt(
                format,
                plugin.settings.summaryLanguage || undefined,
                context || undefined,
            );

            const parts: ContentPart[] = [
                { type: 'text', text: prompt },
                { type: 'image', data: processed.base64, mediaType: processed.mediaType },
            ];

            const response = await sendMultimodalForFlashcards(plugin, parts, { maxTokens: 4000 });
            if (!response.success || !response.content) {
                throw new Error(response.error || 'Empty response from vision LLM');
            }

            reporter.setPhase({ key: 'validating' });
            const csvContent = cleanCSVResponse(response.content);
            const validation = validateFlashcardCSV(csvContent);

            const baseName = `${imageFile.basename} - answers`;
            if (!validation.valid || validation.cardCount === 0) {
                return { csv: '', cardCount: 0, baseName, validationFailed: { errors: validation.errors, csvContent } };
            }

            reporter.setPhase({ key: 'saving', params: { count: validation.cardCount } });
            return { csv: cardsToCSV(validation.cards), cardCount: validation.cardCount, baseName };
        },
    );
    if (!r.ok) return;

    if (r.value.validationFailed) {
        showCSVValidationError(t, r.value.validationFailed.csvContent, r.value.validationFailed.errors);
        return;
    }
    await deliverFlashcards(plugin, r.value.csv, r.value.baseName, format, r.value.cardCount);
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Read content from editor buffer (unsaved changes) or fall back to disk.
 */
async function getEditorContent(plugin: AIOrganiserPlugin, file: TFile): Promise<string> {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path && view.editor) {
        return view.editor.getValue();
    }
    return await plugin.app.vault.read(file);
}

/**
 * Detect embedded images in note content and resolve to TFile objects.
 */
function resolveEmbeddedImages(plugin: AIOrganiserPlugin, content: string, currentFile: TFile): TFile[] {
    const detection = detectEmbeddedContent(plugin.app, content, currentFile);
    if (!detection.hasImages) return [];

    return detection.items
        .filter(item => item.type === 'image' && item.resolvedFile)
        .map(item => item.resolvedFile!);
}

/**
 * Check if the current LLM provider supports multimodal/vision.
 */
function isVisionAvailable(plugin: AIOrganiserPlugin): boolean {
    if (!isMultimodalService(plugin.llmService)) return false;
    const capability = plugin.llmService.getMultimodalCapability();
    return capability !== 'text-only';
}

/**
 * Show appropriate error when CSV validation fails.
 * If the LLM returned prose (refusal), show the actual text.
 */
function showCSVValidationError(
    t: Record<string, string>,
    csvContent: string,
    errors: string[]
): void {
    if (looksLikeProse(csvContent)) {
        const preview = csvContent.length > 200 ? csvContent.slice(0, 200) + '...' : csvContent;
        logger.warn('Export', 'LLM returned prose instead of CSV:', csvContent);
        new Notice(`${t.flashcardGenerationFailed}: ${preview}`, 8000);
    } else {
        const errorMsg = errors.length > 0
            ? errors.slice(0, 3).join('; ')
            : (t.noValidFlashcards || 'No valid flashcards generated');
        new Notice(`${t.flashcardGenerationFailed}: ${errorMsg}`, 5000);
    }
}

/**
 * Assemble content from multiple notes with per-note + total size guardrails.
 */
export async function assembleMultiNoteContent(
    plugin: AIOrganiserPlugin,
    notes: TFile[]
): Promise<{ content: string; wasTruncated: boolean }> {
    const flashcardConfig = await getFlashcardProviderConfig(plugin);
    const provider = flashcardConfig?.provider ?? getServiceType(pluginContext(plugin)).provider;
    const maxTotal = getMaxContentChars(provider);
    const promptOverhead = 3000; // prompt + style instructions + context
    const budget = maxTotal - promptOverhead;
    const perNoteBudget = Math.floor(budget / notes.length);

    const parts: string[] = [];
    let totalChars = 0;
    let wasTruncated = false;

    for (const note of notes) {
        let content = await plugin.app.vault.read(note);
        if (content.length > perNoteBudget) {
            content = content.slice(0, perNoteBudget) + '\n\n[...truncated]';
            wasTruncated = true;
        }
        const part = `## ${note.basename}\n\n${content}`;
        totalChars += part.length;
        if (totalChars > budget && parts.length > 0) {
            wasTruncated = true;
            break;
        }
        parts.push(part);
    }

    return { content: parts.join('\n\n---\n\n'), wasTruncated };
}

/**
 * Deliver flashcard output: system save dialog on desktop, clipboard on mobile.
 */
async function deliverFlashcards(
    plugin: AIOrganiserPlugin,
    csv: string,
    baseName: string,
    format: FlashcardFormat,
    cardCount: number
): Promise<void> {
    const t = plugin.t.messages;

    if (Platform.isDesktopApp) {
        const saved = await saveFlashcardWithDialog(baseName, format, csv);
        if (saved) {
            const successMsg = (t.flashcardsExported || 'Exported {count} flashcards to {path}')
                .replace('{count}', String(cardCount))
                .replace('{path}', saved);
            new Notice(successMsg, 4000);
        }
        // If user cancelled the dialog, do nothing (no error)
    } else {
        await navigator.clipboard.writeText(csv);
        new Notice(
            `${cardCount} ${t.flashcardsTo || 'flashcards copied to'} ${t.copiedToClipboard || 'clipboard'}`,
            3000
        );
    }
}

/**
 * Save flashcard CSV via system save dialog (desktop).
 * Falls back to Downloads folder if dialog unavailable.
 * Returns the saved file path, or null if the user cancelled.
 */
async function saveFlashcardWithDialog(
    baseName: string,
    format: FlashcardFormat,
    csvContent: string
): Promise<string | null> {
    const timestamp = new Date().toISOString().split('T')[0];
    const defaultName = `${baseName} - ${format.id} - ${timestamp}.${format.fileExtension}`;

    // Try system Save dialog via @electron/remote (Obsidian bundles this)
    try {
        type ElectronRemote = { dialog: { showSaveDialog: (opts: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }> } };
        const remote = desktopRequire<ElectronRemote>('@electron/remote');
        const fsMod = getFs();
        if (remote && fsMod) {
            const result = await remote.dialog.showSaveDialog({
                defaultPath: defaultName,
                filters: [
                    { name: 'CSV Files', extensions: [format.fileExtension] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (!result.canceled && result.filePath) {
                fsMod.writeFileSync(result.filePath, csvContent, 'utf-8');
                return result.filePath;
            }
            return null; // User cancelled
        }
    } catch {
        // @electron/remote unavailable — fall back to Downloads folder
    }

    // Fallback: write to Downloads folder
    try {
        const fsMod = getFs();
        const pathMod = getPath();
        const osMod = getOs();
        if (fsMod && pathMod && osMod) {
            const downloadsDir = pathMod.join(osMod.homedir(), 'Downloads');
            const filePath = pathMod.join(downloadsDir, defaultName);
            fsMod.writeFileSync(filePath, csvContent, 'utf-8');
            return filePath;
        }
        throw new Error('Node modules unavailable');
    } catch {
        await navigator.clipboard.writeText(csvContent);
        new Notice('Could not save file — copied to clipboard instead', 4000);
        return null;
    }
}

/**
 * Detect when the LLM returned prose (refusal/explanation) instead of CSV.
 * Checks if the first non-empty line lacks a comma (the CSV column separator).
 */
export function looksLikeProse(text: string): boolean {
    const firstLine = text.split('\n').find(l => l.trim().length > 0) || '';
    // CSV lines should have at least one comma separating Q,A columns.
    // If the first line has no comma, it's almost certainly prose.
    return !firstLine.includes(',');
}

/**
 * Strip markdown code fences from LLM CSV output
 */
function cleanCSVResponse(raw: string): string {
    let csv = raw.trim();
    if (csv.startsWith('```')) {
        csv = csv.replace(/^```(?:csv)?\n?/, '').replace(/\n?```$/, '');
    }
    return csv;
}

/**
 * Create a temporary CloudLLMService for the dedicated flashcard provider,
 * or return null to use the main provider.
 */
async function getFlashcardService(plugin: AIOrganiserPlugin): Promise<CloudLLMService | null> {
    const config = await getFlashcardProviderConfig(plugin);
    if (!config) return null;

    const service = new CloudLLMService({
        type: config.provider,
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        modelName: config.model
    }, plugin.app);

    if (plugin.settings.debugMode) service.setDebugMode(true);
    return service;
}

/**
 * Call LLM service to generate flashcards (text-based workflows).
 * Uses dedicated flashcard provider when configured, otherwise main provider.
 */
async function callLLMForFlashcards(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    const dedicated = await getFlashcardService(plugin);
    if (dedicated) {
        return await withBusyIndicator(plugin, () => dedicated.summarizeText(prompt));
    }
    return await withBusyIndicator(plugin, () => summarizeText(pluginContext(plugin), prompt));
}

/**
 * Send multimodal content for flashcards.
 * Uses dedicated flashcard provider when configured and it supports vision.
 */
async function sendMultimodalForFlashcards(
    plugin: AIOrganiserPlugin,
    parts: ContentPart[],
    options?: { maxTokens?: number }
): Promise<{ success: boolean; content?: string; error?: string }> {
    const dedicated = await getFlashcardService(plugin);
    if (dedicated) {
        const capability = dedicated.getMultimodalCapability();
        if (capability !== 'text-only') {
            return await withBusyIndicator(plugin, () => dedicated.sendMultimodal(parts, options));
        }
        // Dedicated provider doesn't support vision — fall through to main
    }
    return await withBusyIndicator(plugin, () =>
        sendMultimodal(pluginContext(plugin), parts, options)
    );
}
