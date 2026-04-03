/**
 * TaxonomyGuardrailService tests
 *
 * Covers: normalization, lookup maps, semantic scanning, slot classification,
 * LLM repair, tag reconstruction, novel discipline flow, guardrail disabled.
 */

import { vi } from 'vitest';
import {
    TaxonomyGuardrailService
} from '../src/services/taxonomyGuardrailService';
import type { Taxonomy } from '../src/services/configurationService';

// --- Helpers ---

function makeTaxonomy(
    themes: string[] = ['Technology', 'Science', 'Arts'],
    disciplines: string[] = ['Computer Science', 'Biology', 'Music']
): Taxonomy {
    return {
        themes: themes.map(name => ({ name, description: '', useWhen: '' })),
        disciplines: disciplines.map(name => ({ name, description: '', useWhen: '' }))
    };
}

function makeLLMService(response: string) {
    return {
        summarizeText: vi.fn().mockResolvedValue({ success: true, content: response })
    } as any;
}

function makeLLMServiceFailing() {
    return {
        summarizeText: vi.fn().mockRejectedValue(new Error('LLM unavailable'))
    } as any;
}

// --- Tests ---

describe('TaxonomyGuardrailService', () => {
    let service: TaxonomyGuardrailService;

    beforeEach(() => {
        service = new TaxonomyGuardrailService(false);
    });

    // ═══════════════════════════════════════════
    // Normalization
    // ═══════════════════════════════════════════

    describe('normalize()', () => {
        it('lowercases a tag', () => {
            expect(service.normalize('Technology')).toBe('technology');
        });

        it('converts spaces to hyphens', () => {
            expect(service.normalize('Computer Science')).toBe('computer-science');
        });

        it('converts underscores to hyphens', () => {
            expect(service.normalize('computer_science')).toBe('computer-science');
        });

        it('collapses multiple hyphens', () => {
            expect(service.normalize('my--tag---here')).toBe('my-tag-here');
        });

        it('preserves nested tag separators (/)', () => {
            expect(service.normalize('science/biology')).toBe('science/biology');
        });

        it('preserves Unicode Chinese characters', () => {
            expect(service.normalize('技术')).toBe('技术');
        });

        it('preserves accented Latin characters', () => {
            expect(service.normalize('Économie')).toBe('économie');
        });

        it('returns empty string for empty/null input', () => {
            expect(service.normalize('')).toBe('');
            expect(service.normalize(undefined as any)).toBe('');
        });

        it('strips leading/trailing hyphens', () => {
            expect(service.normalize('-tag-')).toBe('tag');
        });

        it('strips special characters except / and -', () => {
            expect(service.normalize('tag@#$%name')).toBe('tagname');
        });
    });

    // ═══════════════════════════════════════════
    // Exact / normalized match
    // ═══════════════════════════════════════════

    describe('exact and normalized matching', () => {
        const taxonomy = makeTaxonomy();

        it('matches exact theme name', async () => {
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.theme.classification).toBe('valid');
            expect(result.theme.resolved).toBe('Technology');
        });

        it('matches theme via case normalization', async () => {
            const result = await service.validateTags(
                ['technology', 'Computer Science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.theme.resolved).toBe('Technology');
            expect(result.theme.matchMethod).toBe('normalized');
        });

        it('matches discipline via case normalization', async () => {
            const result = await service.validateTags(
                ['Technology', 'computer science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.discipline.classification).toBe('valid');
            expect(result.discipline.resolved).toBe('Computer Science');
        });

        it('matches discipline via underscore normalization', async () => {
            const result = await service.validateTags(
                ['Technology', 'computer_science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.discipline.resolved).toBe('Computer Science');
        });

        it('returns success=false when theme is unknown (no LLM)', async () => {
            const result = await service.validateTags(
                ['unknown-theme', 'Computer Science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(false);
            expect(result.theme.classification).toBe('missing');
        });

        it('classifies unknown discipline as novel', async () => {
            const result = await service.validateTags(
                ['Technology', 'quantum-computing', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.discipline.classification).toBe('novel');
            expect(result.discipline.resolved).toBe('quantum-computing');
        });

        it('handles empty tags array', async () => {
            const result = await service.validateTags([], taxonomy);
            expect(result.success).toBe(false);
            expect(result.error).toContain('No tags');
        });

        it('handles single tag that is a theme', async () => {
            const result = await service.validateTags(['Technology'], taxonomy);
            expect(result.success).toBe(true);
            expect(result.theme.resolved).toBe('Technology');
            expect(result.discipline.classification).toBe('missing');
        });
    });

    // ═══════════════════════════════════════════
    // Semantic scanning (position-independent)
    // ═══════════════════════════════════════════

    describe('semantic scanning', () => {
        const taxonomy = makeTaxonomy();

        it('finds theme and discipline in correct order', async () => {
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'topic1'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.tags[0]).toBe('Technology');
            expect(result.tags[1]).toBe('Computer Science');
            expect(result.tags[2]).toBe('topic1');
        });

        it('finds theme and discipline when swapped', async () => {
            const result = await service.validateTags(
                ['Computer Science', 'Technology', 'topic1'],
                taxonomy
            );
            expect(result.success).toBe(true);
            // Theme should be first in output regardless of input position
            expect(result.tags[0]).toBe('Technology');
            expect(result.tags[1]).toBe('Computer Science');
        });

        it('finds theme buried at position 2', async () => {
            const result = await service.validateTags(
                ['neural-networks', 'deep-learning', 'Technology'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.theme.resolved).toBe('Technology');
            expect(result.tags[0]).toBe('Technology');
        });

        it('finds both when at non-standard positions', async () => {
            const result = await service.validateTags(
                ['topic1', 'Biology', 'topic2', 'Science'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.theme.resolved).toBe('Science');
            expect(result.discipline.resolved).toBe('Biology');
            expect(result.tags[0]).toBe('Science');
            expect(result.tags[1]).toBe('Biology');
        });

        it('uses positional fallback when no semantic match for theme', async () => {
            const result = await service.validateTags(
                ['unrecognized-theme', 'unrecognized-discipline', 'topic'],
                taxonomy
            );
            // tags[0] used as theme candidate → unknown → missing → success=false
            expect(result.success).toBe(false);
            expect(result.theme.original).toBe('unrecognized-theme');
        });

        it('resolves conflict when tag matches both theme and discipline names', async () => {
            // Create taxonomy where "Design" is both a theme and a discipline
            const ambiguous = makeTaxonomy(['Design', 'Technology'], ['Design', 'Engineering']);
            const result = await service.validateTags(
                ['Design', 'Engineering', 'topic1'],
                ambiguous
            );
            expect(result.success).toBe(true);
            // First semantic match wins for theme, second slot gets discipline
            expect(result.tags).toContain('Design');
            expect(result.tags).toContain('Engineering');
        });
    });

    // ═══════════════════════════════════════════
    // Tag reconstruction
    // ═══════════════════════════════════════════

    describe('tag reconstruction', () => {
        const taxonomy = makeTaxonomy();

        it('outputs [theme, discipline, ...topics]', async () => {
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'ai', 'machine-learning'],
                taxonomy
            );
            expect(result.tags).toEqual([
                'Technology', 'Computer Science', 'ai', 'machine-learning'
            ]);
        });

        it('puts topics after theme/discipline even when reordered', async () => {
            const result = await service.validateTags(
                ['ai', 'Science', 'Biology', 'evolution'],
                taxonomy
            );
            expect(result.tags[0]).toBe('Science');
            expect(result.tags[1]).toBe('Biology');
            // Topics follow
            expect(result.tags).toContain('ai');
            expect(result.tags).toContain('evolution');
        });

        it('omits discipline from output when missing', async () => {
            const result = await service.validateTags(['Technology'], taxonomy);
            expect(result.tags).toEqual(['Technology']);
        });
    });

    // ═══════════════════════════════════════════
    // Novel discipline flow
    // ═══════════════════════════════════════════

    describe('novel discipline flow', () => {
        const taxonomy = makeTaxonomy();

        it('flags unknown discipline as novel', async () => {
            const result = await service.validateTags(
                ['Technology', 'quantum-computing', 'qubits'],
                taxonomy
            );
            expect(result.discipline.classification).toBe('novel');
            expect(result.discipline.original).toBe('quantum-computing');
            expect(result.discipline.resolved).toBe('quantum-computing');
        });

        it('keeps novel discipline in output tags', async () => {
            const result = await service.validateTags(
                ['Science', 'astrobiology', 'mars'],
                taxonomy
            );
            expect(result.tags[1]).toBe('astrobiology');
        });

        it('does not fail when discipline is novel', async () => {
            const result = await service.validateTags(
                ['Arts', 'digital-art', 'pixel-art'],
                taxonomy
            );
            expect(result.success).toBe(true);
        });

        it('sets matchMethod to none for novel discipline', async () => {
            const result = await service.validateTags(
                ['Technology', 'robotics', 'sensors'],
                taxonomy
            );
            expect(result.discipline.matchMethod).toBe('none');
        });
    });

    // ═══════════════════════════════════════════
    // LLM repair
    // ═══════════════════════════════════════════

    describe('LLM repair', () => {
        const taxonomy = makeTaxonomy();

        it('repairs an unrecognized theme via LLM', async () => {
            const llm = makeLLMService('Technology');
            const result = await service.validateTags(
                ['tech', 'Computer Science', 'ai'],
                taxonomy,
                llm
            );
            expect(result.success).toBe(true);
            expect(result.theme.resolved).toBe('Technology');
            expect(result.theme.matchMethod).toBe('llm-repair');
            expect(result.usedLLMRepair).toBe(true);
        });

        it('handles LLM returning NOVEL for theme → still fails', async () => {
            const llm = makeLLMService('NOVEL');
            const result = await service.validateTags(
                ['aliens', 'Computer Science', 'ai'],
                taxonomy,
                llm
            );
            // Theme can't be novel — must come from taxonomy
            expect(result.success).toBe(false);
            expect(result.theme.classification).toBe('missing');
        });

        it('handles LLM service failure gracefully', async () => {
            const llm = makeLLMServiceFailing();
            const result = await service.validateTags(
                ['tech', 'Computer Science', 'ai'],
                taxonomy,
                llm
            );
            // Repair failed → theme still missing → success=false
            expect(result.success).toBe(false);
            expect(result.usedLLMRepair).toBe(false);
        });

        it('verifies LLM repair result against taxonomy', async () => {
            // LLM returns something not in taxonomy
            const llm = makeLLMService('Nonsense');
            const result = await service.validateTags(
                ['tech', 'Computer Science', 'ai'],
                taxonomy,
                llm
            );
            // Repair returned invalid value → treated as missing
            expect(result.success).toBe(false);
        });

        it('sets usedLLMRepair=false when repair not needed', async () => {
            const llm = makeLLMService('Technology');
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'ai'],
                taxonomy,
                llm
            );
            // Direct match — no repair call needed
            expect(result.usedLLMRepair).toBe(false);
            expect(llm.summarizeText).not.toHaveBeenCalled();
        });

        it('does not attempt repair when no LLM service provided', async () => {
            const result = await service.validateTags(
                ['tech', 'Computer Science', 'ai'],
                taxonomy
                // No LLM service
            );
            expect(result.success).toBe(false);
            expect(result.usedLLMRepair).toBe(false);
        });
    });

    // ═══════════════════════════════════════════
    // Guardrail pass-through (disabled scenario)
    // ═══════════════════════════════════════════

    describe('guardrail pass-through', () => {
        it('passes tags through unchanged when all match taxonomy', async () => {
            const taxonomy = makeTaxonomy();
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'deep-learning', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(result.tags).toEqual([
                'Technology', 'Computer Science', 'deep-learning', 'ai'
            ]);
            expect(result.usedLLMRepair).toBe(false);
        });

        it('preserves all topics after theme and discipline', async () => {
            const taxonomy = makeTaxonomy();
            const result = await service.validateTags(
                ['Technology', 'Computer Science', 'topic1', 'topic2', 'topic3'],
                taxonomy
            );
            expect(result.tags.length).toBe(5);
            expect(result.tags.slice(2)).toEqual(['topic1', 'topic2', 'topic3']);
        });
    });

    // ═══════════════════════════════════════════
    // Debug mode
    // ═══════════════════════════════════════════

    describe('debug mode', () => {
        it('does not throw when debug mode is on', async () => {
            const debugService = new TaxonomyGuardrailService(true);
            const taxonomy = makeTaxonomy();
            const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

            const result = await debugService.validateTags(
                ['Technology', 'Computer Science', 'ai'],
                taxonomy
            );
            expect(result.success).toBe(true);
            expect(spy).toHaveBeenCalled();

            spy.mockRestore();
        });
    });

    // ═══════════════════════════════════════════
    // enforceTagConstraints
    // ═══════════════════════════════════════════

    describe('enforceTagConstraints', () => {
        it('deduplicates tags by normalized form (case-insensitive)', () => {
            const result = service.enforceTagConstraints(
                ['science', 'Science', 'biology'],
                { maxTags: 10 }
            );
            expect(result.data).toEqual(['science', 'biology']);
            expect(result.issues.some(i => i.message.includes('Duplicate'))).toBe(true);
            expect(result.issues.some(i => i.autoFixed)).toBe(true);
        });

        it('truncates to maxTags while preserving theme and discipline at positions 0 and 1', () => {
            const tags = [
                'Technology', 'Computer Science',
                'ai', 'machine-learning', 'deep-learning',
                'neural-networks', 'transformers', 'nlp',
                'data-science', 'python'
            ];
            const result = service.enforceTagConstraints(tags, { maxTags: 5 });

            expect(result.data).toHaveLength(5);
            expect(result.data[0]).toBe('Technology');
            expect(result.data[1]).toBe('Computer Science');
            expect(result.issues.some(i => i.message.includes('Truncated'))).toBe(true);
        });

        it('strips blank topic tags (silently dropped by dedup since normalize returns empty)', () => {
            const taxonomy = makeTaxonomy();
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', '', '  ', 'ai'],
                { maxTags: 10, taxonomy }
            );
            // Blank tags are dropped in dedup step (normalize('') → '' is falsy, skipped)
            expect(result.data).toEqual(['Technology', 'Computer Science', 'ai']);
        });

        it('removes topic that duplicates theme name via case-insensitive dedup', () => {
            const taxonomy = makeTaxonomy();
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', 'technology', 'ai'],
                { maxTags: 10, taxonomy }
            );
            // 'technology' normalizes to same as 'Technology' → caught by dedup step
            expect(result.data).not.toContain('technology');
            expect(result.data).toContain('ai');
            expect(result.issues.some(i => i.message.includes('Duplicate'))).toBe(true);
        });

        it('removes topic that duplicates theme via taxonomy topic validation (different surface form)', () => {
            const taxonomy = makeTaxonomy();
            // Use a topic with underscores that normalizes to match the discipline
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', 'Computer_Science', 'ai'],
                { maxTags: 10, taxonomy }
            );
            // 'Computer_Science' normalizes to 'computer-science' same as 'Computer Science' → caught by dedup
            expect(result.data).not.toContain('Computer_Science');
            expect(result.data).toContain('ai');
        });

        it('removes topic that duplicates discipline name', () => {
            const taxonomy = makeTaxonomy();
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', 'computer-science', 'ai'],
                { maxTags: 10, taxonomy }
            );
            expect(result.data).not.toContain('computer-science');
            expect(result.data).toContain('ai');
        });

        it('returns valid=true with empty issues when no changes needed', () => {
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', 'ai'],
                { maxTags: 10 }
            );
            expect(result.valid).toBe(true);
            expect(result.issues).toEqual([]);
            expect(result.data).toEqual(['Technology', 'Computer Science', 'ai']);
        });

        it('handles 0 tags gracefully', () => {
            const result = service.enforceTagConstraints([], { maxTags: 5 });
            expect(result.valid).toBe(true);
            expect(result.data).toEqual([]);
            expect(result.issues).toEqual([]);
        });

        it('handles single tag without error', () => {
            const result = service.enforceTagConstraints(
                ['Technology'],
                { maxTags: 5 }
            );
            expect(result.valid).toBe(true);
            expect(result.data).toEqual(['Technology']);
        });

        it('does not truncate when tag count equals maxTags exactly', () => {
            const tags = ['Technology', 'Computer Science', 'ai', 'ml', 'nlp'];
            const result = service.enforceTagConstraints(tags, { maxTags: 5 });

            expect(result.data).toHaveLength(5);
            expect(result.issues).toEqual([]);
        });

        it('deduplicates before enforcing maxTags (dedup may reduce below limit)', () => {
            // 6 tags, but 2 are duplicates → 4 unique → maxTags=5 not triggered
            const result = service.enforceTagConstraints(
                ['Technology', 'Computer Science', 'ai', 'AI', 'ml', 'ML'],
                { maxTags: 5 }
            );
            expect(result.data).toEqual(['Technology', 'Computer Science', 'ai', 'ml']);
            expect(result.issues.some(i => i.message.includes('Duplicate'))).toBe(true);
            // No truncation issue since dedup brought it to 4
            expect(result.issues.some(i => i.message.includes('Truncated'))).toBe(false);
        });
    });
});
