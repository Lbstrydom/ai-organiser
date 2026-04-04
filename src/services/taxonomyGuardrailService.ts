/**
 * Taxonomy Guardrail Service
 * Post-LLM validation ensuring exactly 1 valid theme and 1 discipline per tagging operation.
 * Uses deterministic normalization first, LLM repair as fallback.
 */

import { Taxonomy } from './configurationService';
import { SummarizableLLMService } from './types';
import { buildTaxonomyRepairPrompt } from './prompts/tagPrompts';
import type { ValidationResult, ValidationIssue } from './validators/types';
import { logger } from '../utils/logger';

// --- Types ---

/** Classification of how a returned tag relates to the taxonomy */
export type TagClassification = 'valid' | 'missing' | 'novel';

/** Result of validating a single tag position (theme or discipline) */
export interface TaxonomySlotResult {
    classification: TagClassification;
    /** The original value from the LLM (empty string if missing) */
    original: string;
    /** The resolved value (matched taxonomy entry name, or original if novel) */
    resolved: string;
    /** How the match was found */
    matchMethod: 'exact' | 'normalized' | 'llm-repair' | 'none';
}

/** Full result of validating a tag array */
export interface GuardrailResult {
    /** Whether validation succeeded (false = unresolvable theme, skip tagging) */
    success: boolean;
    /** Error message when success is false */
    error?: string;
    /** The corrected tag array with theme at [0], discipline at [1], topics at [2+] */
    tags: string[];
    theme: TaxonomySlotResult;
    discipline: TaxonomySlotResult;
    /** Whether any LLM repair call was needed */
    usedLLMRepair: boolean;
}

// --- Service ---

export class TaxonomyGuardrailService {
    private debugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.debugMode = debugMode;
    }

    /**
     * Normalize a tag for matching: lowercase, kebab-case, strip non-alphanumeric except / and -
     * Preserves Unicode letters (Chinese, accented chars) and nested tag separators (/)
     */
    normalize(tag: string): string {
        if (!tag) return '';
        return tag
            .toLowerCase()
            .replace(/[\s_]+/g, '-')
            .replace(/[^a-z0-9\u00C0-\u024F\u4e00-\u9fff/-]/g, '')
            .replace(/-{2,}/g, '-')
            .replace(/^-|-$/g, '')
            .trim();
    }

    /**
     * Build lookup maps from taxonomy: normalized name → canonical name
     */
    private buildLookupMaps(taxonomy: Taxonomy): {
        themeMap: Map<string, string>;
        disciplineMap: Map<string, string>;
    } {
        const themeMap = new Map<string, string>();
        for (const t of taxonomy.themes) {
            themeMap.set(this.normalize(t.name), t.name);
        }
        const disciplineMap = new Map<string, string>();
        for (const d of taxonomy.disciplines) {
            disciplineMap.set(this.normalize(d.name), d.name);
        }
        return { themeMap, disciplineMap };
    }

    /**
     * Semantic scan: find theme and discipline tags by matching against taxonomy,
     * regardless of position. Falls back to positional (tags[0], tags[1]) as tiebreaker.
     */
    private semanticScan(
        tags: string[],
        themeMap: Map<string, string>,
        disciplineMap: Map<string, string>
    ): { themeIdx: number; disciplineIdx: number } {
        let themeIdx = -1;
        let disciplineIdx = -1;

        // Scan all tags for semantic matches
        for (let i = 0; i < tags.length; i++) {
            const norm = this.normalize(tags[i]);
            if (themeIdx === -1 && themeMap.has(norm)) {
                themeIdx = i;
            }
            if (disciplineIdx === -1 && disciplineMap.has(norm)) {
                disciplineIdx = i;
            }
        }

        // Positional fallback when no semantic match found
        if (themeIdx === -1 && tags.length > 0) themeIdx = 0;
        if (disciplineIdx === -1 && tags.length > 1) {
            disciplineIdx = (themeIdx === 0) ? 1 : 0;
        } else if (disciplineIdx === -1 && tags.length === 1 && themeIdx === 0) {
            // Only one tag, and it's the theme — no discipline candidate
            disciplineIdx = -1;
        }

        // Resolve conflict: if both landed on the same index
        if (themeIdx === disciplineIdx && themeIdx !== -1 && tags.length > 1) {
            // Prefer theme at current position, bump discipline to next available
            for (let i = 0; i < tags.length; i++) {
                if (i !== themeIdx) {
                    disciplineIdx = i;
                    break;
                }
            }
        }

        return { themeIdx, disciplineIdx };
    }

    /**
     * Classify a candidate tag against a lookup map.
     * Returns the slot result with classification and resolved canonical name.
     */
    private classifySlot(
        candidate: string | undefined,
        slotType: 'theme' | 'discipline',
        lookupMap: Map<string, string>
    ): TaxonomySlotResult {
        if (!candidate) {
            return {
                classification: 'missing',
                original: '',
                resolved: '',
                matchMethod: 'none'
            };
        }

        const norm = this.normalize(candidate);

        // Exact normalized match
        if (lookupMap.has(norm)) {
            return {
                classification: 'valid',
                original: candidate,
                resolved: lookupMap.get(norm)!,
                matchMethod: 'normalized'
            };
        }

        // No match — classification depends on slot type
        if (slotType === 'discipline') {
            // Disciplines can be novel (LLM discovered a new one)
            return {
                classification: 'novel',
                original: candidate,
                resolved: candidate,
                matchMethod: 'none'
            };
        }

        // Themes must come from taxonomy — mark as missing for repair
        return {
            classification: 'missing',
            original: candidate,
            resolved: '',
            matchMethod: 'none'
        };
    }

    /**
     * Attempt LLM repair for a tag that couldn't be matched deterministically.
     */
    private async attemptLLMRepair(
        candidate: string,
        slotType: 'theme' | 'discipline',
        lookupMap: Map<string, string>,
        llmService: SummarizableLLMService
    ): Promise<TaxonomySlotResult> {
        const availableOptions = Array.from(lookupMap.values());
        const prompt = buildTaxonomyRepairPrompt(candidate, slotType, availableOptions);

        try {
            const response = await llmService.summarizeText(prompt);
            if (response.success && response.content) {
                const repaired = response.content.trim();

                // Check if LLM said "NOVEL"
                if (repaired.toUpperCase() === 'NOVEL') {
                    return {
                        classification: slotType === 'discipline' ? 'novel' : 'missing',
                        original: candidate,
                        resolved: slotType === 'discipline' ? candidate : '',
                        matchMethod: 'llm-repair'
                    };
                }

                // Verify the repaired tag is actually in the lookup map
                const repairedNorm = this.normalize(repaired);
                if (lookupMap.has(repairedNorm)) {
                    return {
                        classification: 'valid',
                        original: candidate,
                        resolved: lookupMap.get(repairedNorm)!,
                        matchMethod: 'llm-repair'
                    };
                }
            }
        } catch (error) {
            logger.debug('Tags', 'LLM repair failed:', error);
        }

        // Repair failed
        return {
            classification: slotType === 'discipline' ? 'novel' : 'missing',
            original: candidate,
            resolved: slotType === 'discipline' ? candidate : '',
            matchMethod: 'none'
        };
    }

    /**
     * Validate and repair a tag array against the taxonomy.
     *
     * Strategy:
     * 1. Build normalized lookup maps for themes and disciplines
     * 2. Semantic scan: find theme/discipline by matching against maps (not just positional)
     * 3. Deterministic classification via normalized matching
     * 4. LLM repair as fallback for unresolvable mismatches
     * 5. Reconstruct tags as [theme, discipline, ...topics]
     *
     * Returns success=false if theme cannot be resolved (skip tagging entirely).
     */
    async validateTags(
        tags: string[],
        taxonomy: Taxonomy,
        llmService?: SummarizableLLMService
    ): Promise<GuardrailResult> {
        if (tags.length === 0) {
            return {
                success: false,
                error: 'No tags to validate',
                tags: [],
                theme: { classification: 'missing', original: '', resolved: '', matchMethod: 'none' },
                discipline: { classification: 'missing', original: '', resolved: '', matchMethod: 'none' },
                usedLLMRepair: false
            };
        }

        const { themeMap, disciplineMap } = this.buildLookupMaps(taxonomy);
        const { themeIdx, disciplineIdx } = this.semanticScan(tags, themeMap, disciplineMap);

        // Extract candidates
        const themeCandidate = themeIdx >= 0 ? tags[themeIdx] : undefined;
        const disciplineCandidate = disciplineIdx >= 0 ? tags[disciplineIdx] : undefined;

        // Classify theme
        let themeResult = this.classifySlot(themeCandidate, 'theme', themeMap);
        let usedLLMRepair = false;

        // LLM repair for theme if needed
        if (themeResult.classification === 'missing' && themeCandidate && llmService) {
            themeResult = await this.attemptLLMRepair(themeCandidate, 'theme', themeMap, llmService);
            if (themeResult.matchMethod === 'llm-repair') {
                usedLLMRepair = true;
            }
        }

        // If theme is still missing after repair, skip tagging
        if (themeResult.classification === 'missing') {
            return {
                success: false,
                error: `Could not match theme '${themeCandidate || '(none)'}' to any theme in taxonomy`,
                tags,
                theme: themeResult,
                discipline: { classification: 'missing', original: disciplineCandidate || '', resolved: '', matchMethod: 'none' },
                usedLLMRepair
            };
        }

        // Classify discipline
        let disciplineResult = this.classifySlot(disciplineCandidate, 'discipline', disciplineMap);

        // LLM repair for discipline if missing (no candidate at all)
        if (disciplineResult.classification === 'missing' && !disciplineCandidate && llmService) {
            // No discipline candidate — can't repair without a candidate
            disciplineResult = {
                classification: 'missing',
                original: '',
                resolved: '',
                matchMethod: 'none'
            };
        }

        // Reconstruct: [theme, discipline, ...topics]
        const topicIndices = new Set([themeIdx, disciplineIdx]);
        const topics = tags.filter((_, i) => !topicIndices.has(i));

        const resultTags: string[] = [themeResult.resolved];
        if (disciplineResult.resolved) {
            resultTags.push(disciplineResult.resolved);
        }
        resultTags.push(...topics);

        logger.debug('Tags', 'Guardrail result:', {
            theme: themeResult,
            discipline: disciplineResult,
            tags: resultTags,
            usedLLMRepair
        });

        return {
            success: true,
            tags: resultTags,
            theme: themeResult,
            discipline: disciplineResult,
            usedLLMRepair
        };
    }

    /**
     * Post-guardrail enforcement: maxTags, dedup, taxonomy topic validation.
     * Returns ValidationResult<string[]> (DD-6 contract).
     * Runs AFTER validateTags() — operates on the guardrail-corrected tag array.
     */
    enforceTagConstraints(
        tags: string[],
        options: {
            maxTags: number;
            taxonomy?: Taxonomy;
        }
    ): ValidationResult<string[]> {
        const issues: ValidationIssue[] = [];
        let result = [...tags];

        // 1. Deduplication after kebab-case normalization
        const seen = new Map<string, number>(); // normalized → first index
        const deduped: string[] = [];
        for (let i = 0; i < result.length; i++) {
            const norm = this.normalize(result[i]);
            if (norm && !seen.has(norm)) {
                seen.set(norm, i);
                deduped.push(result[i]);
            } else if (norm && seen.has(norm)) {
                issues.push({
                    severity: 'info',
                    field: `tags[${i}]`,
                    message: `Duplicate tag '${result[i]}' removed (matches '${deduped[seen.get(norm)!]}')`,
                    autoFixed: true
                });
            }
        }
        result = deduped;

        // 2. Taxonomy topic validation (positions [2+])
        if (options.taxonomy && result.length > 2) {
            result = this.filterInvalidTopics(result, issues);
        }

        // 3. Max tag count enforcement (preserve theme at [0], discipline at [1])
        if (options.maxTags > 0 && result.length > options.maxTags) {
            const removed = result.slice(options.maxTags);
            result = result.slice(0, options.maxTags);
            issues.push({
                severity: 'info',
                field: 'tags',
                message: `Truncated from ${result.length + removed.length} to ${options.maxTags} tags. Removed: ${removed.join(', ')}`,
                autoFixed: true
            });
        }

        return {
            valid: !issues.some(i => i.severity === 'error'),
            data: result,
            issues
        };
    }

    /**
     * Filter out blank and duplicate-of-theme/discipline topics at positions [2+].
     */
    private filterInvalidTopics(tags: string[], issues: ValidationIssue[]): string[] {
        const themeNorm = tags[0] ? this.normalize(tags[0]) : '';
        const disciplineNorm = tags[1] ? this.normalize(tags[1]) : '';
        const validTopics: string[] = tags.slice(0, 2);

        for (let i = 2; i < tags.length; i++) {
            const topicNorm = this.normalize(tags[i]);
            if (!topicNorm) {
                issues.push({
                    severity: 'warning', field: `tags[${i}]`,
                    message: 'Blank topic tag removed', autoFixed: true
                });
                continue;
            }
            if (topicNorm === themeNorm || topicNorm === disciplineNorm) {
                issues.push({
                    severity: 'warning', field: `tags[${i}]`,
                    message: `Topic '${tags[i]}' duplicates theme/discipline — removed`, autoFixed: true
                });
                continue;
            }
            validTopics.push(tags[i]);
        }
        return validTopics;
    }
}
