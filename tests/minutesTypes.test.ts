import { describe, it, expect } from 'vitest';
import { shouldUseLegacyPath, toLegacySpeakerMapping } from '../src/services/minutes/minutesTypes';

describe('shouldUseLegacyPath', () => {
    it('returns true when no items at all', () => {
        expect(shouldUseLegacyPath({
            populatedTopicCount: 0,
            effectiveSectionIds: new Set(),
        })).toBe(true);
    });

    it('returns true when all items in general only, no topics', () => {
        expect(shouldUseLegacyPath({
            populatedTopicCount: 0,
            effectiveSectionIds: new Set(['general']),
        })).toBe(true);
    });

    it('returns false when ≥1 populated topic exists', () => {
        expect(shouldUseLegacyPath({
            populatedTopicCount: 1,
            effectiveSectionIds: new Set(['general']),
        })).toBe(false);
    });

    it('returns false when items resolve to a non-general section', () => {
        expect(shouldUseLegacyPath({
            populatedTopicCount: 0,
            effectiveSectionIds: new Set(['topic-vat']),
        })).toBe(false);
    });

    it('returns false when items span general AND a topic', () => {
        expect(shouldUseLegacyPath({
            populatedTopicCount: 1,
            effectiveSectionIds: new Set(['general', 'topic-vat']),
        })).toBe(false);
    });
});

describe('toLegacySpeakerMapping', () => {
    it('strips audioItemId prefix from compound keys when no collisions', () => {
        const mapping = {
            entries: new Map([
                ['audio-1|Speaker 0', 'Alice'],
                ['audio-1|Speaker 1', 'Bob'],
            ]),
        };
        const legacy = toLegacySpeakerMapping(mapping);
        expect(legacy.get('Speaker 0')).toBe('Alice');
        expect(legacy.get('Speaker 1')).toBe('Bob');
    });

    it('passes plain keys through unchanged', () => {
        const mapping = {
            entries: new Map([['Speaker 0', 'Alice']]),
        };
        const legacy = toLegacySpeakerMapping(mapping);
        expect(legacy.get('Speaker 0')).toBe('Alice');
    });

    it('preserves both speakers when two audio files share a provider id (H6 fix)', () => {
        const mapping = {
            entries: new Map([
                ['audio-1|Speaker 0', 'Alice'],
                ['audio-2|Speaker 0', 'Charlie'],
            ]),
        };
        const legacy = toLegacySpeakerMapping(mapping);
        // First entry keeps the bare id; collision falls back to composite key
        expect(legacy.get('Speaker 0')).toBe('Alice');
        expect(legacy.get('audio-2|Speaker 0')).toBe('Charlie');
    });
});
