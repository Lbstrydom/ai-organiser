import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { getLanguageNameForPrompt } from './languages';
import {
    Action,
    MeetingMetadata,
    MinutesJSON,
    ParsedMinutes,
    TranscriptSegment,
    buildChunkExtractionPrompt,
    buildConsolidationPrompt,
    buildMinutesSystemPrompt,
    buildMinutesUserPrompt,
    parseMinutesResponse
} from './prompts/minutesPrompts';
import { chunkPlainTextAsync, chunkSegmentsAsync } from '../utils/textChunker';
import { CHUNK_TOKEN_LIMIT, MinutesDetailLevel } from '../core/constants';
import {
    buildMinutesFrontmatter,
    buildMinutesJsonComment,
    buildMinutesMarkdown,
    ensureFolderExists,
    getAvailableFilePath,
    renderMinutesFromJson,
    sanitizeFileName
} from '../utils/minutesUtils';
import { summarizeText, pluginContext } from './llmFacade';
import { withBusyIndicator } from '../utils/busyIndicator';

export interface MinutesGenerationInput {
    metadata: MeetingMetadata;
    participantsRaw: string;
    transcript: TranscriptSegment[] | string;
    personaId?: string;
    outputFolder: string;
    customInstructions?: string;
    languageOverride?: string;
    /** Optional context from attached documents (agendas, presentations, etc.) */
    contextDocuments?: string;
    /** Optional terminology dictionary content for transcription accuracy */
    dictionaryContent?: string;
    /** Minutes output detail level */
    detailLevel?: MinutesDetailLevel;
    /** GTD action classification overlay */
    useGTD?: boolean;
}

export interface MinutesGenerationResult {
    filePath: string;
    markdown: string;
    json: MinutesJSON;
}

interface ChunkExtract {
    chunkIndex: number;
    actions: Action[];
    decisions: any[];
    risks: any[];
    notable_points: any[];
    open_questions: any[];
}

// Use shared CHUNK_TOKEN_LIMIT from constants

export class MinutesService {
    private plugin: AIOrganiserPlugin;

    constructor(plugin: AIOrganiserPlugin) {
        this.plugin = plugin;
    }

    async generateMinutes(input: MinutesGenerationInput): Promise<MinutesGenerationResult> {
        const personaPrompt = await this.plugin.configService.getMinutesPersonaPrompt(input.personaId);
        const outputLanguage = this.getOutputLanguage(input.languageOverride);
        const personaInstructions = input.customInstructions
            ? `${personaPrompt}\n\nAdditional instructions:\n${input.customInstructions}`
            : personaPrompt;

        const useGTD = input.useGTD ?? false;
        let parsed: ParsedMinutes;

        if (this.needsChunking(input.transcript)) {
            parsed = await this.generateMinutesChunked(input, outputLanguage, personaInstructions, useGTD);
        } else {
            const prompt = [
                buildMinutesSystemPrompt({ outputLanguage, personaInstructions, useGTD }),
                buildMinutesUserPrompt(
                    input.metadata,
                    this.parseParticipants(input.participantsRaw),
                    input.participantsRaw,
                    input.transcript,
                    input.contextDocuments,
                    input.dictionaryContent
                )
            ].join('\n\n');

            const responseText = await this.callLLM(prompt);
            parsed = parseMinutesResponse(responseText);
        }

        if (this.plugin.settings.debugMode) {
            console.log('[AI Organiser] Minutes input — contextDocuments:', input.contextDocuments ? `${input.contextDocuments.length} chars` : 'none', '| dictionary:', input.dictionaryContent ? `${input.dictionaryContent.length} chars` : 'none');
            console.log('[AI Organiser] Minutes parsed — json keys:', Object.keys(parsed.json), 'markdown length:', parsed.markdown.length);
        }

        const detailLevel = input.detailLevel || this.plugin.settings.minutesDetailLevel || 'standard';

        // Always render from JSON for reliable output.
        // LLM markdown is used only if it looks like actual markdown (has headings),
        // is substantial (>200 chars), and doesn't look like leftover JSON.
        const llmMarkdown = parsed.markdown.trim();
        const renderedMarkdown = renderMinutesFromJson(parsed.json, detailLevel, input.metadata.obsidianTasksFormat);
        const baseMarkdown = this.isUsableMarkdown(llmMarkdown) ? llmMarkdown : renderedMarkdown;

        const markdown = buildMinutesMarkdown(baseMarkdown, parsed.markdownExternal, {
            includeTasks: input.metadata.obsidianTasksFormat,
            actions: parsed.json.actions || []
        });

        if (this.plugin.settings.debugMode) console.log('[AI Organiser] Minutes markdown built:', markdown.length, 'chars, source:', llmMarkdown.length > 200 ? 'llm' : 'rendered');

        const frontmatter = buildMinutesFrontmatter({
            json: parsed.json,
            fallbackTitle: input.metadata.title,
            fallbackDate: input.metadata.date
        });

        const jsonComment = buildMinutesJsonComment(parsed.json);
        const fullContent = `---\n${frontmatter}---\n\n${markdown}\n\n${jsonComment}`;

        const datePart = parsed.json.metadata?.date || input.metadata.date;
        const safeTitle = sanitizeFileName(parsed.json.metadata?.title || input.metadata.title || 'Meeting Minutes');
        const fileName = `${datePart} ${safeTitle}.md`;

        if (this.plugin.settings.debugMode) console.log('[AI Organiser] Minutes saving to:', input.outputFolder, '/', fileName);

        await ensureFolderExists(this.plugin.app.vault, input.outputFolder);
        const targetPath = await getAvailableFilePath(this.plugin.app.vault, input.outputFolder, fileName);
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
        personaInstructions: string,
        useGTD: boolean
    ): Promise<ParsedMinutes> {
        const chunks = typeof input.transcript === 'string'
            ? await chunkPlainTextAsync(input.transcript, { maxTokens: CHUNK_TOKEN_LIMIT, overlapChars: 500 })
            : await chunkSegmentsAsync(input.transcript, { maxTokens: CHUNK_TOKEN_LIMIT, overlapChars: 500 });

        if (chunks.length === 0) {
            throw new Error('Transcript is empty');
        }

        const extracts: ChunkExtract[] = [];
        for (let i = 0; i < chunks.length; i++) {
            new Notice(
                (this.plugin.t.minutes?.generatingChunk || 'Processing chunk {current}/{total}...')
                    .replace('{current}', String(i + 1))
                    .replace('{total}', String(chunks.length)),
                2000
            );

            const chunkText = Array.isArray(chunks[i])
                ? (chunks[i] as TranscriptSegment[]).map(s => s.text).join('\n')
                : String(chunks[i]);

            const prompt = `${buildChunkExtractionPrompt()}\n\nTranscript chunk:\n${chunkText}`;
            const responseText = await this.callLLM(prompt);
            const parsedExtract = this.parseChunkExtract(responseText);
            extracts.push({ chunkIndex: i, ...parsedExtract });
        }

        const merged = this.mergeChunkExtracts(extracts);
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

        new Notice(this.plugin.t.minutes?.consolidating || 'Consolidating minutes...', 2000);

        const consolidationPrompt = [
            buildConsolidationPrompt({ outputLanguage, personaInstructions, useGTD }),
            JSON.stringify(consolidationPayload, null, 2)
        ].join('\n\n');

        const responseText = await this.callLLM(consolidationPrompt);
        return parseMinutesResponse(responseText);
    }

    private parseChunkExtract(responseText: string): Omit<ChunkExtract, 'chunkIndex'> {
        const cleaned = responseText
            .replace(/^```json?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const parsed = this.parseJsonWithRepair(cleaned) as any;
        return {
            actions: parsed.actions || [],
            decisions: parsed.decisions || [],
            risks: parsed.risks || [],
            notable_points: parsed.notable_points || [],
            open_questions: parsed.open_questions || []
        };
    }

    private parseJsonWithRepair(jsonStr: string): any {
        try {
            return JSON.parse(jsonStr);
        } catch {
            // Attempt repairs below
        }

        let repaired = jsonStr;
        repaired = repaired.replace(/,\s*([}\]])/g, '$1');
        repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

        return JSON.parse(repaired);
    }

    private mergeChunkExtracts(extracts: ChunkExtract[]): ChunkExtract {
        const merged: ChunkExtract = {
            chunkIndex: -1,
            actions: [],
            decisions: [],
            risks: [],
            notable_points: [],
            open_questions: []
        };

        const seenActions = new Set<string>();
        const seenDecisions = new Set<string>();

        for (const extract of extracts) {
            for (const action of extract.actions) {
                const key = this.normalizeForDedup(action.text);
                if (!seenActions.has(key)) {
                    seenActions.add(key);
                    merged.actions.push(action);
                }
            }

            for (const decision of extract.decisions) {
                const key = this.normalizeForDedup(decision.text);
                if (!seenDecisions.has(key)) {
                    seenDecisions.add(key);
                    merged.decisions.push(decision);
                }
            }

            merged.risks.push(...extract.risks);
            merged.notable_points.push(...extract.notable_points);
            merged.open_questions.push(...extract.open_questions);
        }

        return merged;
    }

    private normalizeForDedup(text: string): string {
        return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 120);
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

    /**
     * Check if text looks like usable markdown rather than JSON fragments or garbage.
     * Must be >200 chars, contain at least one markdown heading, and not start with JSON.
     */
    private isUsableMarkdown(text: string): boolean {
        if (text.length <= 200) return false;
        // Reject if it looks like JSON (starts with { or [ after trimming)
        if (text.startsWith('{') || text.startsWith('[')) return false;
        // Require at least one markdown heading
        if (!/^#{1,6}\s/m.test(text)) return false;
        return true;
    }

    private async callLLM(prompt: string): Promise<string> {
        const response = await withBusyIndicator(this.plugin, () => summarizeText(pluginContext(this.plugin), prompt));
        if (response.success && response.content) {
            return response.content;
        }
        throw new Error(response.error || 'Failed to generate minutes');
    }
}
