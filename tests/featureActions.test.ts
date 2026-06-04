import { describe, it, expect } from 'vitest';
import { filterEnabledActions, type FeatureGatedAction } from '../src/ui/utils/featureActions';

interface Action extends FeatureGatedAction { id: string }

describe('filterEnabledActions (FT-13)', () => {
    const actions: Action[] = [
        { id: 'improve' },                          // no feature → always kept
        { id: 'diagram', feature: 'mermaid-chat' },
        { id: 'resources', feature: 'research' },
        { id: 'flashcards', feature: 'flashcards' },
    ];

    it('keeps actions with no feature (host/core actions)', () => {
        const out = filterEnabledActions(actions, { featureFlags: { 'mermaid-chat': false, research: false, flashcards: false } });
        expect(out.map((a) => a.id)).toContain('improve');
    });

    it('drops actions whose owning feature is disabled', () => {
        const out = filterEnabledActions(actions, { featureFlags: { 'mermaid-chat': false, research: true, flashcards: false } });
        const ids = out.map((a) => a.id);
        expect(ids).not.toContain('diagram');
        expect(ids).not.toContain('flashcards');
        expect(ids).toContain('resources');
    });

    it('keeps actions whose feature is enabled', () => {
        const out = filterEnabledActions(actions, { featureFlags: { 'mermaid-chat': true, research: true, flashcards: true } });
        expect(out.map((a) => a.id)).toEqual(['improve', 'diagram', 'resources', 'flashcards']);
    });

    it('coalesces an absent flag to the registry default (mermaid-chat default OFF)', () => {
        // No featureFlags at all → mermaid-chat/flashcards default off, research default on.
        const out = filterEnabledActions(actions, {});
        const ids = out.map((a) => a.id);
        expect(ids).toContain('improve');
        expect(ids).toContain('resources');     // research defaultOn = true
        expect(ids).not.toContain('diagram');   // mermaid-chat defaultOn = false
        expect(ids).not.toContain('flashcards');// flashcards defaultOn = false
    });

    it('returns a new array (no mutation)', () => {
        const out = filterEnabledActions(actions, {});
        expect(out).not.toBe(actions);
    });
});
