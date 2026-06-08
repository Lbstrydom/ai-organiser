/**
 * ContentSizePolicy unit tests — assessment, threshold resolution,
 * fast-model gating, char-per-token heuristics.
 */

import { describe, it, expect } from 'vitest';
import {
    assessContent,
    getQualityChunkThreshold,
    getHierarchicalThreshold,
    estimateCharsPerToken,
    exceedsProviderHardLimit,
    resolveAzureFastDeployment,
    QUALITY_CHUNK_THRESHOLD_SUMMARIZATION,
    QUALITY_CHUNK_THRESHOLD_MINUTES,
    QUALITY_HIERARCHICAL_THRESHOLD_SUMMARIZATION,
    CHUNKING_WARNING_THRESHOLD,
} from '../src/services/contentSizePolicy';

describe('getQualityChunkThreshold', () => {
    it('returns summarization default for unknown types', () => {
        expect(getQualityChunkThreshold('summarization')).toBe(QUALITY_CHUNK_THRESHOLD_SUMMARIZATION);
        expect(getQualityChunkThreshold('translation')).toBe(QUALITY_CHUNK_THRESHOLD_SUMMARIZATION);
    });
    it('returns minutes-specific threshold', () => {
        expect(getQualityChunkThreshold('minutes')).toBe(QUALITY_CHUNK_THRESHOLD_MINUTES);
    });
    it('honours user override when in valid range', () => {
        expect(getQualityChunkThreshold('summarization', { qualityChunkThresholdChars: 60_000 })).toBe(60_000);
    });
    it('ignores out-of-range user override (below min)', () => {
        expect(getQualityChunkThreshold('summarization', { qualityChunkThresholdChars: 5_000 })).toBe(QUALITY_CHUNK_THRESHOLD_SUMMARIZATION);
    });
    it('ignores out-of-range user override (above max)', () => {
        expect(getQualityChunkThreshold('summarization', { qualityChunkThresholdChars: 500_000 })).toBe(QUALITY_CHUNK_THRESHOLD_SUMMARIZATION);
    });
});

describe('getHierarchicalThreshold', () => {
    it('returns minutes-specific value for minutes', () => {
        expect(getHierarchicalThreshold('minutes')).toBeGreaterThan(getHierarchicalThreshold('summarization'));
    });
    it('returns summarization default for other types', () => {
        expect(getHierarchicalThreshold('summarization')).toBe(QUALITY_HIERARCHICAL_THRESHOLD_SUMMARIZATION);
        expect(getHierarchicalThreshold('document')).toBe(QUALITY_HIERARCHICAL_THRESHOLD_SUMMARIZATION);
    });
});

describe('estimateCharsPerToken', () => {
    it('defaults to 4 for Latin text', () => {
        const latin = 'The quick brown fox jumps over the lazy dog.'.repeat(10);
        expect(estimateCharsPerToken('gpt-4', latin)).toBe(4);
    });
    it('returns ~2 for CJK-heavy content', () => {
        const cjk = '这是一段中文文本测试用于验证分词器行为。'.repeat(20);
        expect(estimateCharsPerToken('gpt-4', cjk)).toBe(2);
    });
    it('returns ~3 for code-heavy content', () => {
        const code = 'function foo() { return { bar: [1, 2, 3]; }; };\n'.repeat(20);
        expect(estimateCharsPerToken('gpt-4', code)).toBe(3);
    });
    it('falls back to 4 when no sample provided', () => {
        expect(estimateCharsPerToken('gpt-4')).toBe(4);
    });
});

describe('assessContent', () => {
    const smallText = 'A'.repeat(10_000);
    const mediumText = 'A'.repeat(50_000);
    const largeText = 'A'.repeat(150_000);

    it('returns direct strategy below threshold', () => {
        const r = assessContent(smallText, 'summarization', 'claude');
        expect(r.strategy).toBe('direct');
        expect(r.estimatedChunks).toBe(1);
    });
    it('returns chunk strategy above quality threshold, below hierarchical', () => {
        const r = assessContent(mediumText, 'summarization', 'claude');
        expect(r.strategy).toBe('chunk');
        expect(r.estimatedChunks).toBeGreaterThan(1);
    });
    it('returns hierarchical strategy above hierarchical threshold', () => {
        const r = assessContent(largeText, 'summarization', 'claude');
        expect(r.strategy).toBe('hierarchical');
        expect(r.estimatedChunks).toBeGreaterThanOrEqual(4);
    });
    it('sets mapModelOverride when useHaikuForFastTasks + provider is claude', () => {
        const r = assessContent(mediumText, 'summarization', 'claude', {
            useHaikuForFastTasks: true,
            cloudServiceType: 'claude',
        });
        expect(r.mapModelOverride).toBe('latest-haiku');
    });
    it('does NOT set mapModelOverride when useHaikuForFastTasks is false', () => {
        const r = assessContent(mediumText, 'summarization', 'claude', {
            useHaikuForFastTasks: false,
            cloudServiceType: 'claude',
        });
        expect(r.mapModelOverride).toBeUndefined();
    });
    it('does NOT set mapModelOverride for non-Claude providers', () => {
        const r = assessContent(mediumText, 'summarization', 'openai', {
            useHaikuForFastTasks: true,
            cloudServiceType: 'openai',
        });
        expect(r.mapModelOverride).toBeUndefined();
    });
    // ── Azure fast-model surface-matching (Phase 3) ──────────────────────────
    it('sets mapModelOverride to the azure-openai fast deployment when set', () => {
        const r = assessContent(mediumText, 'summarization', 'azure-openai', {
            cloudServiceType: 'azure-openai',
            azureFastModel: { openai: 'gpt-5.4-nano', claude: 'claude-haiku-4-5' },
        });
        expect(r.mapModelOverride).toBe('gpt-5.4-nano');
    });
    it('sets mapModelOverride to the azure-claude fast deployment when set', () => {
        const r = assessContent(mediumText, 'summarization', 'azure-claude', {
            cloudServiceType: 'azure-claude',
            azureFastModel: { openai: 'gpt-5.4-nano', claude: 'claude-haiku-4-5' },
        });
        expect(r.mapModelOverride).toBe('claude-haiku-4-5');
    });
    it('does NOT cross surfaces — azure-openai ignores the claude fast model', () => {
        const r = assessContent(mediumText, 'summarization', 'azure-openai', {
            cloudServiceType: 'azure-openai',
            azureFastModel: { claude: 'claude-haiku-4-5' },
        });
        expect(r.mapModelOverride).toBeUndefined();
    });
    it('does NOT set mapModelOverride in Azure mode when azureFastModel unset (no regression)', () => {
        const r = assessContent(mediumText, 'summarization', 'azure-openai', {
            cloudServiceType: 'azure-openai',
            azureFastModel: {},
        });
        expect(r.mapModelOverride).toBeUndefined();
    });
    it('Azure fast model does NOT depend on useHaikuForFastTasks', () => {
        const r = assessContent(mediumText, 'summarization', 'azure-openai', {
            useHaikuForFastTasks: false,
            cloudServiceType: 'azure-openai',
            azureFastModel: { openai: 'gpt-5.4-nano' },
        });
        expect(r.mapModelOverride).toBe('gpt-5.4-nano');
    });
    it('includes warningMessage for content above warning threshold', () => {
        const huge = 'A'.repeat(CHUNKING_WARNING_THRESHOLD + 1000);
        const r = assessContent(huge, 'summarization', 'claude');
        expect(r.warningMessage).toBeDefined();
        expect(r.warningMessage).toContain('may take several minutes');
    });
    it('omits warningMessage for content below warning threshold', () => {
        const r = assessContent(mediumText, 'summarization', 'claude');
        expect(r.warningMessage).toBeUndefined();
    });
});

describe('exceedsProviderHardLimit', () => {
    it('returns false for small content', () => {
        expect(exceedsProviderHardLimit('A'.repeat(1_000), 'claude')).toBe(false);
    });
    it('returns true for pathologically large content', () => {
        expect(exceedsProviderHardLimit('A'.repeat(10_000_000), 'claude')).toBe(true);
    });
});

describe('resolveAzureFastDeployment', () => {
    it('surface-matches azure-openai → openai', () => {
        expect(resolveAzureFastDeployment('azure-openai', { openai: 'nano', claude: 'haiku' })).toBe('nano');
    });
    it('surface-matches azure-claude → claude', () => {
        expect(resolveAzureFastDeployment('azure-claude', { openai: 'nano', claude: 'haiku' })).toBe('haiku');
    });
    it('returns undefined for non-azure surfaces', () => {
        expect(resolveAzureFastDeployment('claude', { openai: 'nano' })).toBeUndefined();
        expect(resolveAzureFastDeployment('openai', { claude: 'haiku' })).toBeUndefined();
    });
    it('returns undefined when the matching surface is unset', () => {
        expect(resolveAzureFastDeployment('azure-openai', { claude: 'haiku' })).toBeUndefined();
        expect(resolveAzureFastDeployment('azure-claude', {})).toBeUndefined();
    });
    it('returns undefined for an undefined map', () => {
        expect(resolveAzureFastDeployment('azure-openai', undefined)).toBeUndefined();
    });
    it('trims whitespace and treats blank as undefined', () => {
        expect(resolveAzureFastDeployment('azure-openai', { openai: '  nano  ' })).toBe('nano');
        expect(resolveAzureFastDeployment('azure-openai', { openai: '   ' })).toBeUndefined();
    });
});
