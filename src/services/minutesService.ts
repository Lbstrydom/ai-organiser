import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { getLanguageNameForPrompt } from './languages';
import {
    Action,
    Decision,
    Risk,
    NotablePoint,
    OpenQuestion,
    DeferredItem,
    IntermediateMergeContext,
    MeetingMetadata,
    MinutesJSON,
    ParsedMinutes,
    TranscriptSegment,
    buildChunkExtractionPrompt,
    buildContextExtractionPrompt,
    buildIntermediateMergePrompt,
    buildMinutesUserPrompt,
    buildStyleExtractionPrompt,
    getStyleSystemPrompt,
    buildStyleConsolidationPrompt,
    parseMinutesResponse,
    CONTEXT_SUMMARY_MAX_CHARS,
    STYLE_GUIDE_MAX_CHARS
} from './prompts/minutesPrompts';
import { chunkPlainTextAsync, chunkSegmentsAsync } from '../utils/textChunker';
import { CHUNK_TOKEN_LIMIT, MinutesStyle } from '../core/constants';
import { preprocessTranscript } from './transcriptPreprocessor';
import {
    buildMinutesFrontmatter,
    buildMinutesJsonComment,
    buildMinutesMarkdown,
    ensureFolderExists,
    getAvailableFilePath,
    renderMinutesFromJson,
    sanitizeFileName,
    stripConfidenceAnnotations
} from '../utils/minutesUtils';
import { summarizeText, pluginContext } from './llmFacade';
import { LongRunningOpController } from './longRunningOp/progressController';
import { computeMinutesBudget } from './minutesBudgets';
import { SummarizeOptions } from './types';
import { withBusyIndicator } from '../utils/busyIndicator';
import { tryExtractJson } from '../utils/responseParser';
import { validateMinutesJSON } from './validators/minutesValidator';
import { auditMinutesWithLLM } from './validators/minutesAuditor';
import { getAuditProviderConfig } from './apiKeyHelpers';
import { labelSpeakers } from './speakerLabellingService';

export interface MinutesGenerationInput {
    metadata: MeetingMetadata;
    participantsRaw: string;
    transcript: TranscriptSegment[] | string;
    /** Minutes output style (Phase 2 TRA) */
    minutesStyle?: MinutesStyle;
    outputFolder: string;
    customInstructions?: string;
    languageOverride?: string;
    /** Optional context from attached documents (agendas, presentations, etc.) */
    contextDocuments?: string;
    /** Optional terminology dictionary content for transcription accuracy */
    dictionaryContent?: string;
    /** Optional previous minutes to mimic style/format */
    styleReference?: string;
    /** GTD action classification overlay */
    useGTD?: boolean;
    /** Path where transcript was already saved (by modal's early-save) — skips duplicate creation */
    savedTranscriptPath?: string;
    /** Phase 4: per-chunk progress callback. Fires after each chunk's LLM
     *  call resolves with `(current, total, elapsedMs)`. UI uses this to
     *  render a live "Chunk N of M · Ts" indicator. */
    onProgress?: (current: number, total: number, elapsedMs: number) => void;
    /** Phase 4: AbortController.signal — passed through to each chunk LLM
     *  call. When the caller fires abort, the in-flight chunk aborts and
     *  the outer loop exits with a "cancelled" error. */
    abortSignal?: AbortSignal;
    /** Phase 4: soft-budget notification hook. Fires once when the total
     *  elapsed time exceeds the per-run soft budget (scaled by chunk
     *  count). Consumer typically shows a non-interrupting Notice; the
     *  hard cap at `hardBudgetMs` enforces the actual timeout. */
    onSoftBudget?: (elapsedMs: number, hardBudgetMs: number) => void;
}

export interface MinutesGenerationResult {
    filePath: string;
    markdown: string;
    json: MinutesJSON;
}

interface ChunkExtract {
    chunkIndex: number;
    actions: Action[];
    decisions: Decision[];
    risks: Risk[];
    notable_points: NotablePoint[];
    open_questions: OpenQuestion[];
    deferred_items: DeferredItem[];
}

// Use shared CHUNK_TOKEN_LIMIT from constants
const HIERARCHICAL_THRESHOLD = 4;
const MAX_REDUCTION_DEPTH = 5;
const MAX_CONSOLIDATION_CHARS = 120_000; // ~30K tokens — guard against oversized final payloads
const MAX_TRUNCATION_RETRIES = 3; // escalating retry attempts for truncated JSON

/** Extraction/merge: structured JSON extraction — no reasoning needed.
 *  120s timeout is generous for a single chunk with thinking disabled. */
const EXTRACTION_OPTIONS: SummarizeOptions = {
    maxTokens: 4096,
    disableThinking: true,
    timeoutMs: 120_000,
};

/** Intermediate merge: same as extraction. */
const MERGE_OPTIONS: SummarizeOptions = {
    maxTokens: 4096,
    disableThinking: true,
    timeoutMs: 120_000,
};

/** Consolidation: synthesis task (dedup, cross-reference, renumber).
 *  Thinking disabled — structured JSON extraction doesn't benefit from it,
 *  and adaptive thinking can exhaust the entire token budget on reasoning.
 *  16K base for final MinutesJSON; retryIfTruncated escalates further.
 *  600s timeout for long meetings (up to 6 hours). */
const CONSOLIDATION_OPTIONS: SummarizeOptions = {
    maxTokens: 16384,
    disableThinking: true,
    timeoutMs: 600_000,
};

/** Single-call path (non-chunked): full generation in one shot.
 *  Same budget and timeout as consolidation. */
const SINGLE_CALL_OPTIONS: SummarizeOptions = {
    maxTokens: 16384,
    disableThinking: true,
    timeoutMs: 600_000,
};

/** Style extraction: distill a reference document into a concise style guide.
 *  Low token budget — output should be <800 words (~1K tokens). Thinking disabled
 *  because it's a straightforward extraction task. 60s timeout is generous. */
const STYLE_EXTRACTION_OPTIONS: SummarizeOptions = {
    maxTokens: 2048,
    disableThinking: true,
    timeoutMs: 60_000,
};

/** Context extraction: distill raw documents into a concise reference of meeting-relevant facts.
 *  Slightly higher token budget than style (facts are denser). Thinking disabled. */
const CONTEXT_EXTRACTION_OPTIONS: SummarizeOptions = {
    maxTokens: 4096,
    disableThinking: true,
    timeoutMs: 90_000,
};

export class MinutesService {
    private plugin: AIOrganiserPlugin;

    constructor(plugin: AIOrganiserPlugin) {
        this.plugin = plugin;
    }

    async generateMinutes(input: MinutesGenerationInput): Promise<MinutesGenerationResult> {
        const datePart = input.metadata.date || new Date().toISOString().slice(0, 10);
        const safeTitle = sanitizeFileName(input.metadata.title || 'Meeting Minutes');

        // Create per-meeting subfolder and save transcript FIRST (before LLM calls)
        // so the transcript is never lost even if generation fails
        const meetingFolder = `${input.outputFolder}/${datePart} ${safeTitle}`;
        await ensureFolderExists(this.plugin.app.vault, meetingFolder);

        let transcriptText = typeof input.transcript === 'string'
            ? input.transcript
            : input.transcript.map(s => s.text).join('\n');

        // Phase 2 TRA: Pre-process transcript (normalize, strip corruption, validate completeness)
        const preprocessed = preprocessTranscript(transcriptText);
        transcriptText = preprocessed.cleanTranscript;
        if (preprocessed.warnings.length > 0) {
            for (const warning of preprocessed.warnings) {
                new Notice(warning, 5000);
                logger.debug('Minutes', `Preprocessor warning: ${warning}`);
            }
        }

        // Determine the transcript path: use the already-saved path from modal,
        // or save now (with safety net for "file already exists" race condition)
        let transcriptPath = input.savedTranscriptPath || '';
        if (transcriptText.trim() && !transcriptPath) {
            const transcriptFileName = `${datePart} ${safeTitle} \u2014 Transcript.md`;
            const basePath = `${meetingFolder}/${transcriptFileName}`;
            if (!this.plugin.app.vault.getAbstractFileByPath(basePath)) {
                try {
                    const newPath = await getAvailableFilePath(
                        this.plugin.app.vault, meetingFolder, transcriptFileName
                    );
                    await this.plugin.app.vault.create(newPath, transcriptText);
                    transcriptPath = newPath;
                } catch (e) {
                    // Safety net: file may already exist due to metadata cache lag
                    // from the modal's earlier saveTranscriptToDisk call
                    if (e instanceof Error && e.message.includes('already exists')) {
                        transcriptPath = basePath;
                    } else {
                        throw e;
                    }
                }
            } else {
                // File already exists (early-save worked) — use it
                transcriptPath = basePath;
            }
        }

        // Phase 4 TRA: LLM speaker-labelling pre-pass (before chunking/generation)
        // Overwrites both transcriptText and input.transcript so all downstream paths
        // (single-call, chunked) use the labelled version.
        if (this.plugin.settings.enableSpeakerLabelling && transcriptText.trim().length > 0) {
            try {
                new Notice(this.plugin.t.settings.minutes?.speakerLabelling || 'Labelling speakers...', 2000);
                const participants = this.parseParticipants(input.participantsRaw).map(p => p.name);
                const labellingResult = await labelSpeakers(
                    this.plugin,
                    transcriptText,
                    participants,
                    input.metadata.meetingContext
                );
                transcriptText = labellingResult.labelledTranscript;
                // Overwrite input.transcript so downstream chunking/prompts use labelled text
                input.transcript = transcriptText;
                logger.debug('Minutes', `Speaker labelling: ${labellingResult.speakersFound.length} speakers found, ${labellingResult.unknownSpeakerCount} unknown`);
            } catch (e) {
                // Fail open — if labelling fails, proceed with unlabelled transcript
                logger.warn('Minutes', 'Speaker labelling failed, proceeding with unlabelled transcript', e);
            }
        }

        const outputLanguage = this.getOutputLanguage(input.languageOverride);
        const minutesStyle: MinutesStyle = input.minutesStyle || this.plugin.settings.minutesStyle || 'standard';
        const useGTD = input.useGTD ?? false;
        let parsed: ParsedMinutes;

        // If a raw style reference is provided, distill it into a concise style guide
        // via a cheap LLM call. This saves thousands of tokens in the main prompt and
        // prevents the LLM from copying content verbatim from the reference.
        let styleGuide: string | undefined;
        if (input.styleReference && input.styleReference.trim().length > 0) {
            styleGuide = await this.extractStyleGuide(input.styleReference);
        }

        // If raw context documents are provided, distill them into a concise reference
        // of meeting-relevant facts (names, dates, figures, terms). This can reduce
        // 50,000+ chars to ~3,000 chars of verifiable facts.
        let contextSummary: string | undefined;
        if (input.contextDocuments && input.contextDocuments.trim().length > 0) {
            contextSummary = await this.extractContextSummary(input.contextDocuments);
        }

        if (this.needsChunking(input.transcript)) {
            parsed = await this.generateMinutesChunked(input, outputLanguage, minutesStyle, useGTD, styleGuide, contextSummary);
        } else {
            const prompt = [
                getStyleSystemPrompt({
                    minutesStyle,
                    outputLanguage,
                    useGTD,
                    styleReference: styleGuide,
                    dualOutput: input.metadata.dualOutput,
                    meetingContext: input.metadata.meetingContext,
                    outputAudience: input.metadata.outputAudience,
                    dictionaryContent: input.dictionaryContent,
                    contextSummary,
                    customInstructions: input.customInstructions,
                }),
                buildMinutesUserPrompt(
                    input.metadata,
                    this.parseParticipants(input.participantsRaw),
                    input.participantsRaw,
                    input.transcript,
                    contextSummary,
                    input.dictionaryContent
                )
            ].join('\n\n');

            const responseText = await this.callLLM(prompt, SINGLE_CALL_OPTIONS);
            parsed = parseMinutesResponse(responseText);
        }

        logger.debug('Minutes', 'Minutes input', { contextDocuments: input.contextDocuments ? `${input.contextDocuments.length} chars` : 'none', dictionary: input.dictionaryContent ? `${input.dictionaryContent.length} chars` : 'none' });
        logger.debug('Minutes', 'Minutes parsed', { jsonKeys: Object.keys(parsed.json), markdownLength: parsed.markdown.length });

        // Deterministic validation (Phase 1) — zero API cost, near-zero latency
        const validation = validateMinutesJSON(parsed.json, {
            useGTD: input.useGTD,
            participants: this.parseParticipants(input.participantsRaw).map(p => p.name)
        });

        if (validation.issues.length > 0) {
            logger.debug('Minutes', 'Minutes validation:', validation.issues);
        }

        // Use validated (possibly auto-fixed) JSON
        parsed.json = validation.data;

        const warnings = validation.issues.filter(i => i.severity === 'warning');
        if (warnings.length > 0) {
            new Notice(this.plugin.t.messages.minutesValidationWarnings.replace('{count}', String(warnings.length)), 5000);
        }

        // Phase 5: Optional LLM audit (DD-5: fail-open, never blocking)
        if (this.plugin.settings.enableLLMAudit && this.plugin.llmService) {
            try {
                const providerConfig = await getAuditProviderConfig(this.plugin);
                const validationOptions = {
                    useGTD: input.useGTD,
                    participants: this.parseParticipants(input.participantsRaw).map(p => p.name)
                };
                const auditResult = await auditMinutesWithLLM(
                    parsed.json,
                    transcriptText,
                    validation.issues,
                    this.plugin.llmService,
                    providerConfig,
                    { validationOptions, app: this.plugin.app }
                );
                parsed.json = auditResult.data;
                if (auditResult.issues.length > 0) {
                    logger.debug('Minutes', 'Minutes audit:', auditResult.issues);
                }
            } catch {
                logger.debug('Minutes', 'Minutes audit skipped (error)');
            }
        }

        // Stamp the style onto JSON metadata so DOCX and other consumers can read it
        if (parsed.json.metadata) {
            parsed.json.metadata.style = minutesStyle;
        }

        // Always render from our deterministic renderer for consistent, concise output.
        // LLM markdown is unreliable (verbose, unstructured) — only used for the external
        // (sanitized) version in dual output mode, never for the primary minutes.
        // Strip confidence annotations before validation — Phase 3 TRA.
        const llmMarkdown = stripConfidenceAnnotations(parsed.markdown.trim());
        const renderedMarkdown = renderMinutesFromJson(parsed.json, minutesStyle, input.metadata.obsidianTasksFormat, llmMarkdown);
        const baseMarkdown = renderedMarkdown;

        const markdown = buildMinutesMarkdown(baseMarkdown, parsed.markdownExternal, {
            includeTasks: input.metadata.obsidianTasksFormat,
            actions: parsed.json.actions || []
        });

        logger.debug('Minutes', `Minutes markdown built: ${markdown.length} chars, source: rendered`);

        const frontmatter = buildMinutesFrontmatter({
            json: parsed.json,
            fallbackTitle: input.metadata.title,
            fallbackDate: input.metadata.date,
            transcriptPath: transcriptPath || undefined
        });

        const jsonComment = buildMinutesJsonComment(parsed.json);
        const fullContent = `---\n${frontmatter}---\n\n${markdown}\n\n${jsonComment}`;

        logger.debug('Minutes', `Minutes saving to: ${meetingFolder}`);

        // Save minutes (transcript already saved at top of function)
        const minutesFileName = `${datePart} ${safeTitle} — Minutes.md`;
        const targetPath = await getAvailableFilePath(this.plugin.app.vault, meetingFolder, minutesFileName);
        await this.plugin.app.vault.create(targetPath, fullContent);

        return {
            filePath: targetPath,
            markdown,
            json: parsed.json
        };
    }

    private getOutputLanguage(override?: string): string {
        const overrideLanguage = getLanguageNameForPrompt(override || '');
        if (overrideLanguage) return overrideLanguage;
        return getLanguageNameForPrompt(this.plugin.settings.summaryLanguage) || 'American English';
    }

    /**
     * Distills a raw reference document (previous meeting minutes) into a concise style guide
     * via a lightweight LLM call with thinking disabled. The guide captures formatting conventions,
     * tone, and structure — without any actual content from the reference.
     *
     * Saves thousands of tokens in the main minutes prompt and prevents the LLM from copying
     * content verbatim from the reference document.
     */
    private async extractStyleGuide(referenceDocument: string): Promise<string> {
        logger.debug('Minutes', `Extracting style guide from reference (${referenceDocument.length} chars)`);

        try {
            new Notice(this.plugin.t.minutes?.extractingStyle || 'Extracting style from reference...', 2000);
            const prompt = buildStyleExtractionPrompt(referenceDocument);
            const response = await withBusyIndicator(this.plugin, () =>
                summarizeText(pluginContext(this.plugin), prompt, STYLE_EXTRACTION_OPTIONS)
            );

            if (!response.success || !response.content) {
                logger.warn('Minutes', 'Style extraction failed, falling back to truncated reference');
                // Fallback: use first N characters of the raw reference
                return referenceDocument.substring(0, STYLE_GUIDE_MAX_CHARS) + '\n[Truncated — style extraction failed]';
            }

            const guide = response.content.trim().substring(0, STYLE_GUIDE_MAX_CHARS);

            logger.debug('Minutes', `Style guide extracted: ${guide.length} chars (from ${referenceDocument.length} char reference)`);

            return guide;
        } catch (e) {
            logger.warn('Minutes', 'Style extraction error', e);
            // Graceful fallback
            return referenceDocument.substring(0, STYLE_GUIDE_MAX_CHARS) + '\n[Truncated — style extraction failed]';
        }
    }

    /**
     * Distills raw context documents (agendas, presentations, spreadsheets) into a concise
     * reference sheet of meeting-relevant facts via a lightweight LLM call.
     *
     * Extracts names, dates, figures, agenda items, acronyms, and project codes while
     * discarding narrative prose. This can reduce 50,000+ chars of raw documents down
     * to ~3,000 chars of verifiable reference facts — a major token saving.
     */
    private async extractContextSummary(contextDocuments: string): Promise<string> {
        logger.debug('Minutes', `Extracting context summary from documents (${contextDocuments.length} chars)`);

        try {
            new Notice(this.plugin.t.minutes?.extractingContext || 'Extracting key facts from documents...', 2000);
            const prompt = buildContextExtractionPrompt(contextDocuments);
            const response = await withBusyIndicator(this.plugin, () =>
                summarizeText(pluginContext(this.plugin), prompt, CONTEXT_EXTRACTION_OPTIONS)
            );

            if (!response.success || !response.content) {
                logger.warn('Minutes', 'Context extraction failed, falling back to truncated documents');
                return contextDocuments.substring(0, CONTEXT_SUMMARY_MAX_CHARS) + '\n[Truncated — context extraction failed]';
            }

            const summary = response.content.trim().substring(0, CONTEXT_SUMMARY_MAX_CHARS);

            logger.debug('Minutes', `Context summary extracted: ${summary.length} chars (from ${contextDocuments.length} char documents)`);

            return summary;
        } catch (e) {
            logger.warn('Minutes', 'Context extraction error', e);
            return contextDocuments.substring(0, CONTEXT_SUMMARY_MAX_CHARS) + '\n[Truncated — context extraction failed]';
        }
    }

    private needsChunking(transcript: TranscriptSegment[] | string): boolean {
        const text = typeof transcript === 'string'
            ? transcript
            : transcript.map(segment => segment.text).join(' ');
        const maxChars = CHUNK_TOKEN_LIMIT * 4;
        return text.length > maxChars;
    }

    private async generateMinutesChunked(
        input: MinutesGenerationInput,
        outputLanguage: string,
        minutesStyle: MinutesStyle,
        useGTD: boolean,
        styleGuide?: string,
        contextSummary?: string
    ): Promise<ParsedMinutes> {
        const chunks = typeof input.transcript === 'string'
            ? await chunkPlainTextAsync(input.transcript, { maxTokens: CHUNK_TOKEN_LIMIT, overlapChars: 500 })
            : await chunkSegmentsAsync(input.transcript, { maxTokens: CHUNK_TOKEN_LIMIT, overlapChars: 500 });

        if (chunks.length === 0) {
            throw new Error('Transcript is empty');
        }

        // Phase 4: two-tier budget scaled by chunk count.
        // - Caller can pass their own abortSignal (from the modal's Cancel
        //   button). If absent, we manufacture a purely-internal controller
        //   so the hard cap still enforces.
        // - onProgress fires per completed chunk so the UI's live
        //   "Chunk N of M · Ts" indicator updates.
        // - onSoftBudget surfaces a non-interrupting notice so the user
        //   knows the run is taking longer than expected.
        const budget = computeMinutesBudget(chunks.length);
        const ownAbort = new AbortController();
        const abortCombined = () => ownAbort.abort();
        if (input.abortSignal) {
            if (input.abortSignal.aborted) ownAbort.abort();
            else input.abortSignal.addEventListener('abort', abortCombined, { once: true });
        }
        const controller = new LongRunningOpController({
            softBudgetMs: budget.softBudgetMs,
            hardBudgetMs: budget.hardBudgetMs,
            expected: chunks.length,
            abortController: ownAbort,
            onProgress: (current, _expected, elapsedMs) => {
                input.onProgress?.(current, chunks.length, elapsedMs);
            },
            onSoftBudget: (elapsedMs) => {
                input.onSoftBudget?.(elapsedMs, budget.hardBudgetMs);
            },
        });

        const extracts: ChunkExtract[] = [];
        try {
            for (let i = 0; i < chunks.length; i++) {
                if (ownAbort.signal.aborted) {
                    throw new Error(this.plugin.t.minutes?.cancelled || 'Minutes generation cancelled.');
                }
                new Notice(
                    (this.plugin.t.minutes?.generatingChunk || 'Processing chunk {current}/{total}...')
                        .replace('{current}', String(i + 1))
                        .replace('{total}', String(chunks.length)),
                    2000
                );

                const chunk = chunks[i];
                const chunkText = Array.isArray(chunk)
                    ? (chunk).map(s => s.text).join('\n')
                    : typeof chunk === 'string' ? chunk : JSON.stringify(chunk);

                const prompt = `${buildChunkExtractionPrompt({
                    outputLanguage,
                    meetingContext: input.metadata.meetingContext,
                    agenda: input.metadata.agenda,
                    participantsRaw: input.participantsRaw,
                    dictionaryContent: input.dictionaryContent,
                    contextSummary,
                })}\n\nTranscript chunk ${i + 1}/${chunks.length}:\n${chunkText}`;
                const responseText = await this.callLLM(prompt, EXTRACTION_OPTIONS);
                const parsedExtract = this.parseChunkExtract(responseText);
                extracts.push({ chunkIndex: i, ...parsedExtract });
                controller.recordProgress(i + 1);
            }
        } finally {
            controller.dispose();
            if (input.abortSignal) {
                input.abortSignal.removeEventListener('abort', abortCombined);
            }
        }

        let merged = await this.reduceExtracts(extracts, 0, {
            outputLanguage,
            participantsRaw: input.participantsRaw,
        });
        const consolidationPayload: Record<string, unknown> = {
            meeting: {
                title: input.metadata.title,
                date: input.metadata.date,
                start_time: input.metadata.startTime,
                end_time: input.metadata.endTime,
                timezone: input.metadata.timezone,
                meeting_context: input.metadata.meetingContext,
                output_audience: input.metadata.outputAudience,
                confidentiality_level: input.metadata.confidentialityLevel,
                chair: input.metadata.chair,
                location: input.metadata.location,
                agenda: input.metadata.agenda,
                dual_output: input.metadata.dualOutput,
                minute_taker: input.metadata.minuteTaker
            },
            participants: this.parseParticipants(input.participantsRaw),
            participants_raw: input.participantsRaw,
            extracts: merged
        };

        // Include dictionary in consolidation for name/term consistency
        if (input.dictionaryContent && input.dictionaryContent.trim().length > 0) {
            consolidationPayload.terminology_dictionary = input.dictionaryContent;
        }

        // Include distilled context documents in consolidation for name/figure verification
        if (contextSummary && contextSummary.trim().length > 0) {
            consolidationPayload.context_documents = contextSummary;
        }

        // Payload guard: if oversized after reduction, demote low-confidence items
        // then trim largest arrays to fit under the budget.
        let payloadStr = JSON.stringify(consolidationPayload);
        if (payloadStr.length > MAX_CONSOLIDATION_CHARS) {
            const beforeSize = payloadStr.length;
            merged = this.demoteLowConfidenceItems(merged);
            consolidationPayload.extracts = merged;
            payloadStr = JSON.stringify(consolidationPayload);

            // If still oversized, trim from tail of largest array iteratively
            if (payloadStr.length > MAX_CONSOLIDATION_CHARS) {
                merged = this.trimExtractToFit(merged, consolidationPayload, MAX_CONSOLIDATION_CHARS);
                consolidationPayload.extracts = merged;
                payloadStr = JSON.stringify(consolidationPayload);
            }

            logger.warn('Minutes', `Consolidation payload reduced: ${beforeSize} → ${payloadStr.length} chars (limit: ${MAX_CONSOLIDATION_CHARS})`);
        }

        new Notice(this.plugin.t.minutes?.consolidating || 'Consolidating minutes...', 2000);

        const consolidationPrompt = [
            buildStyleConsolidationPrompt({
                minutesStyle,
                outputLanguage,
                useGTD,
                styleReference: styleGuide,
                dualOutput: input.metadata.dualOutput,
                meetingContext: input.metadata.meetingContext,
                outputAudience: input.metadata.outputAudience,
                dictionaryContent: input.dictionaryContent,
                contextSummary,
                customInstructions: input.customInstructions,
            }),
            JSON.stringify(consolidationPayload)
        ].join('\n\n');

        // Scale token budget based on extract payload size.
        // Heuristic: output JSON is typically ~60-80% of the extract payload size.
        // Start with a budget that can accommodate the expected output to avoid retries.
        const scaledOptions = this.scaleConsolidationBudget(payloadStr.length, CONSOLIDATION_OPTIONS);

        const responseText = await this.callLLM(consolidationPrompt, scaledOptions);
        return parseMinutesResponse(responseText);
    }

    /**
     * Scale the consolidation token budget based on extract payload size.
     * Heuristic: the final MinutesJSON output is typically 60-80% of the input extract size.
     * Estimate needed tokens = (payloadChars * 0.75) / charsPerToken, clamped to [base, 64000].
     */
    private scaleConsolidationBudget(payloadChars: number, baseOptions: SummarizeOptions): SummarizeOptions {
        const CHARS_PER_TOKEN = 4;
        const MAX_OUTPUT_TOKENS = 64000;
        const estimatedOutputChars = payloadChars * 0.75;
        const estimatedTokens = Math.ceil(estimatedOutputChars / CHARS_PER_TOKEN);
        const baseTokens = baseOptions.maxTokens || 16384;
        const scaledTokens = Math.min(Math.max(estimatedTokens, baseTokens), MAX_OUTPUT_TOKENS);

        if (scaledTokens !== baseTokens) {
            logger.debug('Minutes', `Consolidation budget scaled: ${baseTokens} → ${scaledTokens} tokens (payload: ${payloadChars} chars)`);
        }

        return scaledTokens === baseTokens ? baseOptions : { ...baseOptions, maxTokens: scaledTokens };
    }

    private parseChunkExtract(responseText: string): Omit<ChunkExtract, 'chunkIndex'> {
        const parsed = tryExtractJson(responseText) as Partial<ChunkExtract> | null;
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Failed to extract JSON from chunk response');
        }

        const fields = ['actions', 'decisions', 'risks', 'notable_points', 'open_questions', 'deferred_items'] as const;
        let missingCount = 0;
        const parsedRec = parsed as Record<string, unknown>;
        for (const field of fields) {
            if (!Array.isArray(parsedRec[field])) {
                missingCount++;
                logger.warn('Minutes', `parseChunkExtract: missing field "${field}", defaulting to []`);
            }
        }
        if (missingCount === fields.length) {
            throw new Error('LLM response contained no recognizable extract fields');
        }

        return {
            actions: parsed.actions || [],
            decisions: parsed.decisions || [],
            risks: parsed.risks || [],
            notable_points: parsed.notable_points || [],
            open_questions: parsed.open_questions || [],
            deferred_items: parsed.deferred_items || []
        };
    }

    private mergeChunkExtracts(extracts: ChunkExtract[]): ChunkExtract {
        const merged: ChunkExtract = {
            chunkIndex: -1,
            actions: [],
            decisions: [],
            risks: [],
            notable_points: [],
            open_questions: [],
            deferred_items: []
        };

        const fields = ['actions', 'decisions', 'risks', 'notable_points', 'open_questions'] as const;
        const seenSets: Record<string, Set<string>> = {};
        for (const f of fields) seenSets[f] = new Set<string>();

        for (const extract of extracts) {
            for (const field of fields) {
                for (const item of extract[field]) {
                    const key = this.normalizeForDedup(item.text);
                    if (!seenSets[field].has(key)) {
                        seenSets[field].add(key);
                        (merged[field] as Array<typeof item>).push(item);
                    }
                }
            }
            // deferred_items are not deduplicated: they are rarer, less structured
            // (no consistent `text` field for normalization), and the consolidation
            // LLM resolves any duplicates during final synthesis.
            merged.deferred_items.push(...(extract.deferred_items || []));
        }

        return merged;
    }

    private normalizeForDedup(text: string): string {
        return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 120);
    }

    /**
     * Move low-confidence items from primary arrays to open_questions for review.
     * Preserves discoverability without bloating the consolidation payload.
     */
    private demoteLowConfidenceItems(extract: ChunkExtract): ChunkExtract {
        const demotable = ['actions', 'decisions', 'notable_points'] as const;
        const result = { ...extract };
        const demoted: OpenQuestion[] = [];

        for (const field of demotable) {
            const items = result[field] as Array<{ confidence?: string; text?: string }>;
            const kept: Array<{ confidence?: string; text?: string }> = [];
            for (const item of items) {
                if (item.confidence === 'low') {
                    demoted.push({
                        id: `Q${demoted.length + result.open_questions.length + 1}`,
                        text: `Review: ${item.text} (low confidence ${field.replace('_', ' ').replace(/s$/, '')})`,
                        confidence: 'low'
                    });
                } else {
                    kept.push(item);
                }
            }
            (result as Record<string, unknown>)[field] = kept;
        }

        result.open_questions = [...result.open_questions, ...demoted];
        return result;
    }

    /**
     * Trim the largest arrays iteratively until the serialized payload fits under maxChars.
     * Removes from the tail of the largest array each iteration.
     *
     * NOTE: Mutates `payloadShell.extracts` during size checks. The caller must
     * re-assign `payloadShell.extracts` after this call to ensure consistency.
     */
    private trimExtractToFit(
        extract: ChunkExtract,
        payloadShell: Record<string, unknown>,
        maxChars: number
    ): ChunkExtract {
        const result = {
            ...extract,
            actions: [...extract.actions],
            decisions: [...extract.decisions],
            risks: [...extract.risks],
            notable_points: [...extract.notable_points],
            open_questions: [...extract.open_questions],
            deferred_items: [...extract.deferred_items],
        };

        const trimmable = ['notable_points', 'open_questions', 'risks', 'actions', 'decisions'] as const;

        // Trim iteratively until under budget or nothing left to trim
        while (true) {
            payloadShell.extracts = result;
            if (JSON.stringify(payloadShell).length <= maxChars) break;

            // Find the largest trimmable array and remove from tail
            let largestField: typeof trimmable[number] = 'notable_points';
            let largestSize = 0;
            for (const field of trimmable) {
                if (result[field].length > largestSize) {
                    largestSize = result[field].length;
                    largestField = field;
                }
            }

            if (largestSize === 0) break; // nothing left to trim
            result[largestField].pop();
        }

        return result;
    }

    /**
     * Recursively reduce extracts via LLM-based intermediate merging.
     * At ≤HIERARCHICAL_THRESHOLD extracts, uses the existing programmatic merge (no LLM).
     */
    private async reduceExtracts(
        extracts: ChunkExtract[],
        depth = 0,
        mergeContext?: IntermediateMergeContext
    ): Promise<ChunkExtract> {
        if (extracts.length <= HIERARCHICAL_THRESHOLD || depth >= MAX_REDUCTION_DEPTH) {
            return this.mergeChunkExtracts(extracts);
        }

        const batches = this.batchExtracts(extracts, HIERARCHICAL_THRESHOLD);
        const reduced: ChunkExtract[] = [];
        const pass = depth + 1;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];

            // Single-item batches need no merging — pass through
            if (batch.length === 1) {
                reduced.push(batch[0]);
                continue;
            }

            new Notice(
                (this.plugin.t.minutes?.intermediateConsolidation || 'Consolidating group {current}/{total} (pass {pass})...')
                    .replace('{current}', String(i + 1))
                    .replace('{total}', String(batches.length))
                    .replace('{pass}', String(pass)),
                2000
            );

            const prompt = `${buildIntermediateMergePrompt(mergeContext)}\n\nExtracts to merge:\n${JSON.stringify(batch)}`;
            const responseText = await this.callLLM(prompt, MERGE_OPTIONS);
            const parsed = this.parseChunkExtract(responseText);
            reduced.push({ chunkIndex: -1, ...parsed });
        }

        return this.reduceExtracts(reduced, depth + 1, mergeContext);
    }

    private batchExtracts(extracts: ChunkExtract[], size: number): ChunkExtract[][] {
        const batches: ChunkExtract[][] = [];
        for (let i = 0; i < extracts.length; i += size) {
            batches.push(extracts.slice(i, i + size));
        }
        return batches;
    }

    private parseParticipants(raw: string): import('./prompts/minutesPrompts').Participant[] {
        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                const cleaned = line.replace(/^[-*]\s+/, '');
                // Parse pipe-separated format: Name | Title | Company
                const parts = cleaned.split('|').map(p => p.trim());
                if (parts.length >= 3) {
                    return {
                        name: parts[0],
                        role: parts[1] || undefined,
                        organisation: parts[2] || undefined
                    };
                }
                if (parts.length === 2) {
                    return {
                        name: parts[0],
                        role: parts[1] || undefined
                    };
                }
                // Legacy format: "Name (Role) - Present" or "Name (Role)"
                const legacyMatch = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*(?:-\s*\w+)?$/);
                if (legacyMatch) {
                    return {
                        name: legacyMatch[1].trim(),
                        role: legacyMatch[2].trim()
                    };
                }
                return { name: cleaned };
            });
    }

    private async callLLM(prompt: string, options?: SummarizeOptions): Promise<string> {
        const startTime = Date.now();
        logger.debug('Minutes', `LLM call — maxTokens: ${options?.maxTokens ?? 'default'}, thinking: ${options?.disableThinking ? 'off' : 'on'}, prompt: ${prompt.length} chars`);
        const response = await withBusyIndicator(this.plugin, () => summarizeText(pluginContext(this.plugin), prompt, options));
        logger.debug('Minutes', `LLM response — ${Date.now() - startTime}ms, content: ${response.content?.length ?? 0} chars, success: ${response.success}`);
        if (!response.success || !response.content) {
            throw new Error(response.error || 'Failed to generate minutes');
        }
        return this.retryIfTruncated(response.content, prompt, options);
    }

    /** If the response looks like truncated JSON (unbalanced braces) and a maxTokens
     *  budget was set, retry with escalating budgets (2x → 4x → cap) up to
     *  MAX_TRUNCATION_RETRIES times. Returns the longest successful response,
     *  or the last attempt's content if all retries still truncate.
     *  Cap at 64K output tokens — hard limit for Claude Sonnet/Opus. */
    private async retryIfTruncated(content: string, prompt: string, options?: SummarizeOptions): Promise<string> {
        if (!options?.maxTokens) return content;
        if (!this.looksLikeTruncatedJson(content)) return content;

        const MAX_OUTPUT_TOKENS = 64000; // Claude model hard cap
        let bestContent = content;
        let currentBudget = options.maxTokens;

        for (let attempt = 1; attempt <= MAX_TRUNCATION_RETRIES; attempt++) {
            currentBudget = Math.min(currentBudget * 2, MAX_OUTPUT_TOKENS);

            logger.warn('Minutes', `Response looks truncated (${bestContent.length} chars, unbalanced braces). Retry ${attempt}/${MAX_TRUNCATION_RETRIES} with maxTokens: ${currentBudget}.`);

            const startTime = Date.now();
            const retryOptions = { ...options, maxTokens: currentBudget };
            const retry = await withBusyIndicator(this.plugin, () => summarizeText(pluginContext(this.plugin), prompt, retryOptions));

            logger.debug('Minutes', `Truncation retry ${attempt} — ${Date.now() - startTime}ms, maxTokens: ${currentBudget}, success: ${retry.success}, content: ${retry.content?.length ?? 0} chars`);

            if (retry.success && retry.content) {
                bestContent = retry.content;
                // If this attempt produced complete JSON, stop retrying
                if (!this.looksLikeTruncatedJson(bestContent)) {
                    logger.debug('Minutes', `Truncation resolved on retry ${attempt} (${bestContent.length} chars).`);
                    return bestContent;
                }
            }

            // If we've already hit the cap, no point retrying with the same budget
            if (currentBudget >= MAX_OUTPUT_TOKENS) {
                logger.warn('Minutes', `Hit max output token cap (${MAX_OUTPUT_TOKENS}). Returning best content (${bestContent.length} chars).`);
                break;
            }
        }

        return bestContent;
    }

    /** Detect likely truncation: content contains a JSON opening brace but braces
     *  are unbalanced (output was cut off mid-JSON by token limit). */
    private looksLikeTruncatedJson(content: string): boolean {
        const firstBrace = content.indexOf('{');
        if (firstBrace === -1) return false;
        // Count brace depth, skipping string literals
        const jsonPart = content.slice(firstBrace);
        return this.hasUnbalancedBraces(jsonPart);
    }

    private hasUnbalancedBraces(text: string): boolean {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (const ch of text) {
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            if (depth === 0) return false;
        }
        return true;
    }
}
