/**
 * MultiSourceOrchestrator (Cluster C / Phase 4).
 *
 * Owns the per-source `detect → extract → transcribe → summarize` pipeline for a
 * multi-source summarize run, error-isolated per source (one source's throw becomes
 * that source's failure outcome; the others continue). Editor-free: it reads the
 * vault for note/audio resolution but never touches the editor/view or writes the
 * note — the command adapter owns the snapshot + `applyNoteEdit` write seam.
 *
 * Egress runs through the injected `summarizeContent`/`summarizePdf` seams, which
 * already hold the foreground gate (`plugin.withForeground`) + busy indicator — so
 * the orchestrator inherits D4 gating without reading raw provider settings.
 *
 * Behavior-identical to the legacy `handleMultiSourceResult` per-source loops; the
 * `summaryParity` golden test locks the final note content.
 */

import { TFile } from 'obsidian';
import { Result, ok, err, BatchResult, BatchError } from '../../core/result';
import { logger } from '../../utils/logger';
import { withBusyIndicator } from '../../utils/busyIndicator';
import { fetchArticle } from '../webContentService';
import { buildSummaryPrompt, SummaryPromptOptions } from '../prompts/summaryPrompts';
import { getLanguageNameForPrompt } from '../languages';
import { summarizeYouTubeWithGemini } from '../youtubeService';
import { transcribeAudioWithFullWorkflow, AudioWorkflowProgress } from '../audioTranscriptionService';
import { getYouTubeGeminiApiKey, getAudioTranscriptionApiKey } from '../apiKeyHelpers';
import type { VisionService } from '../visionService';
import type {
    MultiSourceDeps,
    MultiSourceRunOptions,
    ProcessedSource,
    ResolvedSource,
    SourceOutcome,
} from './multiSourceTypes';

/** Lazily-constructed image-digitisation context (dynamic import, mirrors legacy). */
interface VisionContext {
    service: VisionService;
    canDigitise: { supported: boolean; reason?: string };
    extractImageText: typeof import('../../utils/digitiseUtils')['extractImageText'];
}

export class MultiSourceOrchestrator {
    constructor(private readonly deps: MultiSourceDeps) {}

    /**
     * Process every source in order, returning an ordered `BatchResult<SourceOutcome>`.
     * Never throws — a catastrophic failure surfaces as `err`, but per-source failures
     * are captured as failed outcomes inside the batch.
     */
    async run(
        sources: ResolvedSource[],
        opts: MultiSourceRunOptions,
    ): Promise<Result<BatchResult<SourceOutcome>>> {
        try {
            const outcomes = await this.processAll(sources, opts);
            // Abort completion (G1): if the run was cancelled mid-loop, refuse the
            // partial result so the command layer discards it and writes nothing —
            // a partial summary must never be silently inserted.
            if (opts.signal?.aborted) {
                return err('aborted');
            }
            const errors: BatchError[] = outcomes
                .filter((o) => !o.processed.success)
                .map((o) => ({
                    source: o.processed.url || o.processed.title,
                    error: o.processed.error || 'Failed',
                }));
            const successCount = outcomes.length - errors.length;
            const isPartial = successCount > 0 && errors.length > 0;
            return ok({ items: outcomes, errors, warnings: [], isPartial });
        } catch (e) {
            logger.error('Summary', 'Multi-source orchestrator failed:', e);
            return err('orchestrator-failed');
        }
    }

    private async processAll(
        sources: ResolvedSource[],
        opts: MultiSourceRunOptions,
    ): Promise<SourceOutcome[]> {
        const total = sources.length;
        const outcomes: SourceOutcome[] = [];

        // Fetch the per-kind credentials once (only when that kind is present), matching
        // the legacy pre-loop fetches.
        const hasYouTube = sources.some((s) => s.kind === 'youtube');
        const hasAudio = sources.some((s) => s.kind === 'audio');
        // Fetch credentials defensively (G3): a throwing secret lookup (vault locked,
        // decryption failure) degrades to null — the affected sources fail individually
        // with their "no key" message rather than aborting the whole batch.
        const youtubeGeminiKey = hasYouTube ? await this.safeFetch(() => getYouTubeGeminiApiKey(this.deps.plugin)) : null;
        const audioConfig = hasAudio ? await this.safeFetch(() => getAudioTranscriptionApiKey(this.deps.plugin)) : null;

        // Vision context is lazily constructed on first image. The init runs INSIDE
        // processImage's try/catch (Gemini-gate G2) so a dynamic-import failure isolates
        // to that image's outcome instead of aborting the whole batch.
        let visionState: VisionContext | null = null;
        const getVision = async (): Promise<VisionContext> => {
            if (!visionState) visionState = await this.initVision();
            return visionState;
        };

        let processed = 0;
        for (const source of sources) {
            if (opts.signal?.aborted) break;
            opts.onProgress?.(processed, total);

            let outcome: SourceOutcome;
            switch (source.kind) {
                case 'note':
                    outcome = await this.processNote(source.file, opts);
                    break;
                case 'url':
                    outcome = await this.processUrl(source.url, opts);
                    break;
                case 'youtube':
                    outcome = await this.processYouTube(source.url, youtubeGeminiKey, opts);
                    break;
                case 'pdf':
                    outcome = await this.processPdf(source.path, source.isVaultFile, opts);
                    break;
                case 'document':
                    outcome = await this.processDocument(source.path, source.isVaultFile, opts);
                    break;
                case 'audio':
                    outcome = await this.processAudio(source.path, source.isVaultFile, audioConfig, opts);
                    break;
                case 'image':
                    outcome = await this.processImage(source.path, opts, getVision);
                    break;
            }
            outcomes.push(outcome);
            processed++;
        }
        return outcomes;
    }

    /** Run an async fetch, degrading a throw to null + a warning (G3 — credential isolation). */
    private async safeFetch<T>(fn: () => Promise<T>): Promise<T | null> {
        try {
            return await fn();
        } catch (e) {
            logger.warn('Summary', 'Multi-source credential fetch failed; degrading to null:', e);
            return null;
        }
    }

    // ── Per-source handlers (each error-isolated, returns one outcome) ──────────

    private async processNote(file: TFile, opts: MultiSourceRunOptions): Promise<SourceOutcome> {
        const base: ProcessedSource = { type: 'note', title: file.basename, date: opts.today, success: false };
        try {
            const content = await this.deps.app.vault.read(file);
            this.deps.notify(this.deps.plugin.t.messages.summarizingNoteContent, 5000);
            const summary = await this.deps.summarizeContent(content, opts.personaPrompt, opts.focusContext, false, opts.signal);
            if (summary) {
                return { processed: { ...base, success: true }, summary, label: `Current Note: ${file.basename}` };
            }
            return { processed: { ...base, error: 'Failed to generate summary' } };
        } catch (e) {
            logger.error('Summary', 'Failed to summarize note:', e);
            return { processed: { ...base, error: e instanceof Error ? e.message : 'Unknown error' } };
        }
    }

    private async processUrl(url: string, opts: MultiSourceRunOptions): Promise<SourceOutcome> {
        const t = this.deps.plugin.t.messages;
        try {
            this.deps.notify(t.fetchingWebPage, 5000);
            const webResult = await fetchArticle(url);
            if (webResult.success && webResult.content) {
                const title = webResult.content.title?.substring(0, 40) || 'web page';
                this.deps.notify(t.summarizingTitle.replace('{title}', title), 10000);
                const summary = await this.deps.summarizeContent(webResult.content.textContent, opts.personaPrompt, opts.focusContext, false, opts.signal);
                const fullTitle = webResult.content.title || url;
                if (summary) {
                    return { processed: { type: 'web', url, title, date: opts.today, success: true }, summary, label: `URL: ${fullTitle}` };
                }
                return { processed: { type: 'web', url, title, date: opts.today, success: false, error: 'Failed to generate summary' } };
            }
            return {
                processed: {
                    type: 'web', url, title: url, date: opts.today, success: false,
                    error: webResult.error || 'Could not fetch page (may require login or JavaScript)',
                },
            };
        } catch (e) {
            logger.error('Summary', `Failed to summarize URL ${url}:`, e);
            this.deps.notify(t.failedToFetchUrl.replace('{url}', url));
            return { processed: { type: 'web', url, title: url, date: opts.today, success: false, error: e instanceof Error ? e.message : 'Network error' } };
        }
    }

    private async processYouTube(url: string, youtubeGeminiKey: string | null, opts: MultiSourceRunOptions): Promise<SourceOutcome> {
        const plugin = this.deps.plugin;
        const t = plugin.t.messages;
        try {
            if (youtubeGeminiKey) {
                this.deps.notify(t.processingYouTubeWithGemini, 5000);
                const promptOptions: SummaryPromptOptions = {
                    length: plugin.settings.summaryLength,
                    language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
                    personaPrompt: opts.personaPrompt,
                    userContext: opts.focusContext,
                };
                const prompt = buildSummaryPrompt(promptOptions);
                const geminiResult = await summarizeYouTubeWithGemini(
                    url,
                    youtubeGeminiKey,
                    prompt,
                    plugin.settings.youtubeGeminiModel,
                    plugin.settings.summarizeTimeoutSeconds * 1000,
                );
                const title = geminiResult.videoInfo?.title || url;
                if (geminiResult.success && geminiResult.content) {
                    this.deps.notify(t.summarizedTitle.replace('{title}', title.substring(0, 40)), 3000);
                    return { processed: { type: 'youtube', url, title, date: opts.today, success: true }, summary: geminiResult.content, label: `YouTube: ${title}` };
                }
                return { processed: { type: 'youtube', url, title, date: opts.today, success: false, error: geminiResult.error || 'Gemini failed to process video' } };
            }
            return {
                processed: {
                    type: 'youtube', url, title: url, date: opts.today, success: false,
                    error: 'Configure Gemini API key in Settings > YouTube to enable video processing',
                },
            };
        } catch (e) {
            logger.error('Summary', `Failed to summarize YouTube ${url}:`, e);
            this.deps.notify(t.failedToProcessYouTube.replace('{url}', url));
            return { processed: { type: 'youtube', url, title: url, date: opts.today, success: false, error: e instanceof Error ? e.message : 'Could not process video' } };
        }
    }

    private async processPdf(path: string, isVaultFile: boolean, opts: MultiSourceRunOptions): Promise<SourceOutcome> {
        const pdfTitle = path.split('/').pop() || path;
        try {
            this.deps.notify(this.deps.plugin.t.messages.readingPdf.replace('{title}', pdfTitle), 3000);
            const pdfResult = await this.deps.summarizePdf(path, isVaultFile, {
                personaPrompt: opts.personaPrompt,
                userContext: opts.focusContext,
                currentFilePath: opts.currentFilePath,
            });
            if (pdfResult.success && pdfResult.summary) {
                return { processed: { type: 'pdf', url: path, title: pdfTitle, date: opts.today, success: true }, summary: pdfResult.summary, label: `PDF: ${pdfTitle}` };
            }
            return { processed: { type: 'pdf', url: path, title: pdfTitle, date: opts.today, success: false, error: pdfResult.error || 'Failed to summarize PDF' } };
        } catch (e) {
            logger.error('Summary', 'Error processing PDF:', e);
            return { processed: { type: 'pdf', url: path, title: pdfTitle, date: opts.today, success: false, error: e instanceof Error ? e.message : 'Unknown error' } };
        }
    }

    private async processDocument(path: string, isVaultFile: boolean, opts: MultiSourceRunOptions): Promise<SourceOutcome> {
        const docTitle = path.split('/').pop() || path;
        try {
            const extraction = await this.deps.extractDocument({ path, isVaultFile }, opts.currentFilePath);
            if (extraction.success && extraction.text) {
                this.deps.notify(this.deps.plugin.t.messages.summarizingTitle.replace('{title}', docTitle.substring(0, 40)), 5000);
                const summary = await this.deps.summarizeContent(extraction.text, opts.personaPrompt, opts.focusContext, false, opts.signal);
                if (summary) {
                    return { processed: { type: 'document', url: path, title: docTitle, date: opts.today, success: true }, summary, label: `Document: ${docTitle}` };
                }
                return { processed: { type: 'document', url: path, title: docTitle, date: opts.today, success: false, error: 'Failed to generate summary' } };
            }
            return { processed: { type: 'document', url: path, title: docTitle, date: opts.today, success: false, error: extraction.error || 'Failed to extract document text' } };
        } catch (e) {
            logger.error('Summary', 'Error processing document:', e);
            return { processed: { type: 'document', url: path, title: docTitle, date: opts.today, success: false, error: e instanceof Error ? e.message : 'Unknown error' } };
        }
    }

    private async processAudio(
        path: string,
        isVaultFile: boolean,
        audioConfig: Awaited<ReturnType<typeof getAudioTranscriptionApiKey>>,
        opts: MultiSourceRunOptions,
    ): Promise<SourceOutcome> {
        const plugin = this.deps.plugin;
        const t = plugin.t.messages;
        const audioTitle = path.split('/').pop() || path;
        const fail = (error: string): SourceOutcome => ({ processed: { type: 'audio', url: path, title: audioTitle, date: opts.today, success: false, error } });

        if (!audioConfig) {
            return fail('Audio transcription requires OpenAI or Groq API key. Configure in Settings > Audio Transcription.');
        }
        try {
            if (!isVaultFile) {
                return fail('External audio files not supported in multi-source mode');
            }
            let audioFile = this.deps.app.metadataCache.getFirstLinkpathDest(path, opts.currentFilePath || '');
            if (!audioFile) {
                const directFile = this.deps.app.vault.getAbstractFileByPath(path);
                if (directFile instanceof TFile) audioFile = directFile;
            }
            if (!(audioFile instanceof TFile)) {
                return fail('Could not find audio file in vault');
            }
            // Capture into a const so the narrowed TFile type survives the closure (no cast).
            const file: TFile = audioFile;

            const transcriptionResult = await withBusyIndicator(plugin, () =>
                transcribeAudioWithFullWorkflow(
                    plugin.app,
                    file,
                    {
                        provider: audioConfig.provider,
                        apiKey: audioConfig.key,
                        azureEndpoint: audioConfig.azureEndpoint,
                        language: plugin.settings.summaryLanguage || undefined,
                    },
                    (progress: AudioWorkflowProgress) => {
                        if (progress.stage === 'compressing') {
                            this.deps.notify(plugin.t.messages.compressingAudio || 'Compressing audio...', 2000);
                        } else if (progress.stage === 'transcribing') {
                            if (progress.totalChunks && progress.totalChunks > 1) {
                                this.deps.notify(`Transcribing chunk ${progress.currentChunk}/${progress.totalChunks}...`, 2000);
                            } else {
                                this.deps.notify(plugin.t.messages.transcribingAudio || 'Transcribing audio...', 2000);
                            }
                        }
                    },
                ),
            );

            if (!transcriptionResult.success || !transcriptionResult.transcript) {
                return fail(transcriptionResult.error || 'Failed to transcribe audio');
            }

            // Post-transcription cleanup: offer keep / compress / delete. Passes the full
            // result so the cleanup can read compression savings (compressedData/size).
            if (this.deps.onAudioCleanup) {
                await this.deps.onAudioCleanup(file, transcriptionResult);
            }

            this.deps.notify(t.summarizingTitle.replace('{title}', audioTitle.substring(0, 40)), 5000);
            const summary = await this.deps.summarizeContent(transcriptionResult.transcript, opts.personaPrompt, opts.focusContext, false, opts.signal);
            if (summary) {
                return { processed: { type: 'audio', url: path, title: audioTitle, date: opts.today, success: true }, summary, label: `Audio: ${audioTitle}` };
            }
            return fail('Failed to generate summary from transcript');
        } catch (e) {
            logger.error('Summary', 'Error processing audio:', e);
            return fail(e instanceof Error ? e.message : 'Unknown error');
        }
    }

    private async initVision(): Promise<VisionContext> {
        const { VisionService } = await import('../visionService');
        const { extractImageText } = await import('../../utils/digitiseUtils');
        const service = new VisionService(this.deps.plugin);
        return { service, canDigitise: service.canDigitise(), extractImageText };
    }

    private async processImage(
        path: string,
        opts: MultiSourceRunOptions,
        getVision: () => Promise<VisionContext>,
    ): Promise<SourceOutcome> {
        const imageTitle = path.split('/').pop() || path;
        const fail = (error: string | undefined): SourceOutcome => ({ processed: { type: 'image', url: path, title: imageTitle, date: opts.today, success: false, error } });

        try {
            // Init INSIDE the try so a dynamic-import failure isolates here (G2).
            const vision = await getVision();
            if (!vision.canDigitise.supported) {
                return fail(vision.canDigitise.reason);
            }
            this.deps.notify(this.deps.plugin.t.messages.summarizingTitle.replace('{title}', imageTitle.substring(0, 40)), 5000);
            const extracted = await vision.extractImageText(vision.service, this.deps.app, path, opts.currentFilePath);
            if ('error' in extracted) {
                return fail(extracted.error);
            }
            const summary = await this.deps.summarizeContent(extracted.text, opts.personaPrompt, opts.focusContext, false, opts.signal);
            if (summary) {
                return { processed: { type: 'image', url: path, title: imageTitle, date: opts.today, success: true }, summary, label: `Image: ${imageTitle}` };
            }
            return fail('Failed to summarize digitised content');
        } catch (e) {
            logger.error('Summary', 'Error processing image:', e);
            return fail(e instanceof Error ? e.message : 'Unknown error');
        }
    }
}
